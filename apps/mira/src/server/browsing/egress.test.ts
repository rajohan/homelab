import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { browserContainerSpec } from "./container";
import { verifyBrowserEgress } from "./egress";

const networkId = "a".repeat(64),
    proxyId = "b".repeat(64),
    browserId = "c".repeat(64),
    proxyImageId = `sha256:${"d".repeat(64)}`;
const config = { networkId, proxyId, proxyImageId };
function fixture() {
    const env = ["PATH=/usr/bin:/bin"];
    const network = {
        Id: networkId,
        Driver: "bridge",
        Internal: true,
        EnableIPv6: false,
        Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
        Containers: { [proxyId]: {} } as Record<string, unknown>,
    };
    const slot = {
        NetworkID: networkId,
        Aliases: ["mira-egress"],
        DriverOpts: { "com.docker.network.endpoint.ifname": "browser" },
    };
    const proxy = {
        Id: proxyId,
        Image: proxyImageId,
        Mounts: [] as unknown[],
        Config: {
            User: "0:0",
            Entrypoint: ["/usr/local/bin/mira-egress"],
            Cmd: null as string[] | null,
            Env: [...env],
            Healthcheck: { Test: ["CMD", "/usr/local/bin/mira-egress-health"] },
        },
        State: { Running: true, Health: { Status: "healthy" } },
        HostConfig: {
            Privileged: false,
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            CapAdd: ["CAP_SETPCAP", "CAP_NET_ADMIN", "CAP_SETUID", "CAP_SETGID"],
            SecurityOpt: ["no-new-privileges:true"],
            NetworkMode: networkId,
            PidMode: "",
            IpcMode: "private",
            Binds: [] as unknown[],
            PortBindings: {} as Record<string, unknown>,
            Sysctls: { "net.ipv4.ip_forward": "0" },
            Init: false,
        },
        NetworkSettings: {
            Networks: {
                slot,
                external: { NetworkID: "e".repeat(64), Aliases: [], DriverOpts: null },
            } as Record<
                string,
                typeof slot | { NetworkID: string; Aliases: string[]; DriverOpts: null }
            >,
        },
    };
    const browser = {
        Id: browserId,
        HostConfig: { NetworkMode: networkId, Dns: ["127.0.0.1"] },
        NetworkSettings: {
            Networks: { slot: { NetworkID: networkId } } as Record<
                string,
                { NetworkID: string }
            >,
        },
    };
    const replies: Record<string, unknown> = {
        [`/networks/${networkId}`]: network,
        [`/containers/${proxyId}/json`]: proxy,
        [`/images/${proxyImageId}/json`]: { Id: proxyImageId, Config: { Env: env } },
        [`/containers/${browserId}/json`]: browser,
    };
    return {
        network,
        proxy,
        slot,
        browser,
        check: (joined = false) =>
            verifyBrowserEgress(
                (_method, route) =>
                    Promise.resolve({
                        status: route in replies ? 200 : 404,
                        body: replies[route],
                    }),
                config,
                joined ? browserId : undefined
            ),
    };
}

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
