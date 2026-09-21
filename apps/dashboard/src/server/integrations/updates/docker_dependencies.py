"""Bounded, deployment-approved coordination of immutable Docker namespace bindings."""

NAMESPACE_KEYS = ("network_mode", "pid", "ipc")


def namespace_services(services, service):
    """Order transitive namespace consumers and reject cycles before any mutation."""
    selected, ordered, visiting = {service}, [], set()
    while True:
        added = {name for name, config in services.items() if any(
            config.get(key, "").removeprefix("service:") in selected
            and config.get(key, "").startswith("service:") for key in NAMESPACE_KEYS)} - selected
        if not added:
            break
        selected.update(added)
    def visit(name):
        if name in ordered:
            return
        if name in visiting:
            raise RuntimeError("Shared namespace dependency cycle")
        visiting.add(name)
        for key in NAMESPACE_KEYS:
            reference = services[name].get(key, "")
            if reference.startswith("service:") and reference[8:] in selected:
                visit(reference[8:])
        visiting.remove(name)
        ordered.append(name)
    for name in sorted(selected):
        visit(name)
    return ordered


def namespace_snapshot(identity):
    """Inspect only safe ownership, immutable image/mount bindings and lifecycle state."""
    template = '{{json .Id}},{{json .Name}},{{json .Config.Image}},{{json .Image}},{{json .State.Status}},{{json .State.StartedAt}},{{json (index .Config.Labels "com.docker.compose.project")}},{{json (index .Config.Labels "com.docker.compose.service")}},{{json .HostConfig.NetworkMode}},{{json .HostConfig.PidMode}},{{json .HostConfig.IpcMode}},{{json .Mounts}}'
    result = json.loads("[" + command(["/usr/bin/docker", "inspect", "--format", template, identity]) + "]")
    # Compose adds its default `z` mode when reattaching image-declared anonymous
    # volumes. Compare their actual source, driver and RW setting, not that spelling.
    for mount in result[11]:
        if mount["Type"] == "volume":
            mount.pop("Mode", None)
    result[11] = sorted(result[11], key=lambda mount: (mount["Destination"], mount["Source"]))
    return result


def prepare_namespace_plan(config, driver, compose):
    """Fence namespace replacement to existing, explicitly approved same-project consumers."""
    services, root = config["services"], driver["service"]
    order = namespace_services(services, root)
    dependents = set(order) - {root}
    approved = set(driver.get("namespaceDependents", []))
    if dependents != approved:
        raise RuntimeError("Namespace consumers changed or require deployment approval")
    snapshots = []
    for name in order:
        ids = compose(["ps", "--all", "--quiet", name]).split()
        if len(ids) != 1 or not re.fullmatch(r"[a-f0-9]{64}", ids[0]):
            raise RuntimeError("Namespace services must have one existing container")
        snapshot = namespace_snapshot(ids[0])
        if snapshot[6:8] != [driver["project"], name] or snapshot[2] != services[name].get("image") or snapshot[4] not in {"running", "exited", "created"}:
            raise RuntimeError("Namespace consumer state or image changed")
        snapshots.append(snapshot)
    selected_ids = {row[0] for row in snapshots}
    for row in snapshots:
        for index in (8, 9, 10):
            reference = row[index]
            if not reference.startswith("container:"):
                continue
            provider = namespace_snapshot(reference[10:])
            if row[4] == "running" and provider[4] != "running":
                raise RuntimeError("A stopped namespace provider still has a running consumer")
            if provider[6] != driver["project"] or (provider[0] not in selected_ids and provider[4] != "running"):
                raise RuntimeError("A namespace provider is missing, stopped or outside this project")
    verify_namespace_membership(snapshots)
    return snapshots


def verify_namespace_membership(plan):
    """Repeat the bounded reverse-edge scan so a pull cannot hide newly added consumers."""
    selected_ids = {row[0] for row in plan}
    if selected_ids:
        # Inspect only immutable namespace references, never environment values.
        ids = command(["/usr/bin/docker", "ps", "--all", "--quiet", "--no-trunc"]).split()
        if len(ids) > 500:
            raise RuntimeError("Namespace topology exceeds its inspection budget")
        template = '{{.Id}} {{.HostConfig.NetworkMode}} {{.HostConfig.PidMode}} {{.HostConfig.IpcMode}}'
        for offset in range(0, len(ids), 50):
            for line in command(["/usr/bin/docker", "inspect", "--format", template] + ids[offset:offset + 50]).splitlines():
                parts = line.split()
                if parts[0] not in selected_ids and any(value.startswith("container:") and value[10:] in selected_ids for value in parts[1:]):
                    raise RuntimeError("An unapproved container shares the selected namespace")


def verify_namespace_plan(plan):
    """Reject a changed consumer before stopping anything or changing a Compose pin."""
    if any(namespace_snapshot(row[0]) != row for row in plan):
        raise RuntimeError("Namespace dependencies changed during update preparation")
    verify_namespace_membership(plan)


def stop_namespace_consumers(plan, root, compose):
    """Stop only previously running approved consumers, in reverse dependency order."""
    running = [row[7] for row in reversed(plan) if row[7] != root and row[4] == "running"]
    if running:
        progress("stopping_dependents")
        compose(["stop", "--timeout", "30"] + running, timeout=30 * len(running) + 30)


def restore_namespace_consumers(plan, root, compose):
    """Rebind consumers without pulling images or starting intentionally stopped services."""
    if len(plan) > 1:
        progress("rebinding_dependents")
    replacements = []
    for row in plan:
        if row[7] == root:
            continue
        state = ["--wait", "--wait-timeout", "120"] if row[4] == "running" else ["--no-start"]
        compose(["up", "--detach", "--no-deps", "--no-build", "--pull", "never", "--force-recreate"] + state + [row[7]], timeout=180)
        current = namespace_snapshot(row[1])
        checks = {"image": current[2:4] == row[2:4], "ownership": current[6:8] == row[6:8], "mounts": current[11] == row[11], "state": (current[4] == "running") == (row[4] == "running")}
        if not all(checks.values()):
            raise RuntimeError("Namespace consumer verification failed: " + ", ".join(name for name, valid in checks.items() if not valid))
        replacements.append({"previousId": row[0], "containerId": current[0], "installed": current[3]})
    by_service = {row[7]: namespace_snapshot(row[1]) for row in plan}
    root_before = next(row for row in plan if row[7] == root)
    if by_service[root][11] != root_before[11]:
        raise RuntimeError("Updated service data mounts changed unexpectedly")
    old_to_new = {row[0]: by_service[row[7]][0] for row in plan}
    for row in plan:
        current = by_service[row[7]]
        if (current[4] == "running") != (row[4] == "running"):
            raise RuntimeError("An application left its expected state during dependency recovery")
        if row[4] == "running":
            state = json.loads(command(["/usr/bin/docker", "inspect", "--format", "{{json .State}}", current[0]]))
            if state["Status"] != "running" or state.get("Health", {}).get("Status", "healthy") != "healthy":
                raise RuntimeError("An application failed its final dependency health check")
        for index in (8, 9, 10):
            expected = row[index]
            if expected.startswith("container:") and expected[10:] in old_to_new:
                expected = "container:" + old_to_new[expected[10:]]
            if current[index] != expected:
                raise RuntimeError("A namespace consumer still references the old provider")
    return replacements


def docker_health_checks(driver):
    """Run deployment-owned functional probes without exposing command output."""
    for arguments in driver.get("healthChecks", []):
        command(arguments, timeout=30, output_limit=65_536)
