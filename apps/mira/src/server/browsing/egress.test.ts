import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { browserEgressFixture as fixture } from "../testing/browserEgressFixture";
import { browserContainerSpec } from "./container";

const networkId = "a".repeat(64),
    proxyId = "b".repeat(64),
    browserId = "c".repeat(64),
    proxyImageId = `sha256:${"d".repeat(64)}`;
const config = { networkId, proxyId, proxyImageId };

test("only the fixed public policy is added to online containers", () => {
    const spec = browserContainerSpec(proxyImageId, crypto.randomUUID(), config);
    expect(spec.NetworkDisabled).toBe(false);
    expect(spec.Env).toEqual(["MIRA_BROWSER_NETWORK=public"]);
    expect(spec.HostConfig.NetworkMode).toBe(networkId);
    expect(spec.HostConfig.Dns).toEqual(["127.0.0.1"]);
    expect(spec.HostConfig.Binds).toEqual([]);
    expect(spec.HostConfig.PortBindings).toEqual({});
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.Tmpfs["/etc/chromium/policies/managed"]).toContain("noexec");
});

test("only the reserved browser may join its exact private slot", async () => {
    const f = fixture();
    await f.check();
    f.network.Containers[browserId] = {};
    await f.check(true);
    await rejects(f.check());
    f.network.Containers["f".repeat(64)] = {};
    await rejects(f.check(true));
});

test("proxy identity, readiness, executable policy and network separation fail closed", async () => {
    const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
        (f) => {
            f.network.Internal = false;
        },
        (f) => {
            f.network.EnableIPv6 = true;
        },
        (f) => {
            f.network.Options["com.docker.network.bridge.gateway_mode_ipv4"] = "nat";
        },
        (f) => {
            f.proxy.Image = `sha256:${"f".repeat(64)}`;
        },
        (f) => {
            f.proxy.State.Health.Status = "unhealthy";
        },
        (f) => {
            f.proxy.State.Running = false;
        },
        (f) => {
            f.proxy.Config.Env.push("LD_PRELOAD=/tmp/untrusted");
        },
        (f) => {
            f.proxy.Config.Entrypoint = ["sh"];
        },
        (f) => {
            f.proxy.Config.Cmd = ["untrusted"];
        },
        (f) => {
            f.proxy.Config.Healthcheck.Test = ["CMD", "true"];
        },
        (f) => {
            f.proxy.HostConfig.Privileged = true;
        },
        (f) => {
            f.proxy.HostConfig.CapAdd.push("SYS_ADMIN");
        },
        (f) => {
            f.proxy.HostConfig.PortBindings["3128/tcp"] = [{}];
        },
        (f) => {
            f.proxy.HostConfig.Binds.push("/host:/host");
        },
        (f) => {
            f.proxy.Mounts.push({ Type: "bind" });
        },
        (f) => {
            f.proxy.HostConfig.NetworkMode = "host";
        },
        (f) => {
            f.proxy.HostConfig.Sysctls["net.ipv4.ip_forward"] = "1";
        },
        (f) => {
            f.slot.DriverOpts["com.docker.network.endpoint.ifname"] = "external";
        },
        (f) => {
            f.slot.Aliases = [];
        },
    ];
    for (const change of changes) {
        const f = fixture();
        change(f);
        await rejects(f.check());
    }
});

test("a live browser cannot acquire another route or an external DNS resolver", async () => {
    for (const change of [
        (f: ReturnType<typeof fixture>) => {
            f.browser.HostConfig.Dns = ["1.1.1.1"];
        },
        (f: ReturnType<typeof fixture>) => {
            f.browser.NetworkSettings.Networks.other = { NetworkID: "f".repeat(64) };
        },
    ]) {
        const f = fixture();
        f.network.Containers[browserId] = {};
        change(f);
        await rejects(f.check(true));
    }
});
