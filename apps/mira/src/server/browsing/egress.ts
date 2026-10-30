import * as v from "valibot";

import type { BrowserDockerRequest } from "./docker";

const id = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const imageId = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/));
export const browserEgressSchema = v.strictObject({
    networkId: id,
    proxyId: id,
    proxyImageId: imageId,
});
export type BrowserEgress = v.InferOutput<typeof browserEgressSchema>;
const endpoint = v.object({
    NetworkID: id,
    Aliases: v.nullable(v.array(v.string())),
    DriverOpts: v.nullable(v.record(v.string(), v.string())),
});
const networkSchema = v.object({
    Id: id,
    Driver: v.literal("bridge"),
    Internal: v.literal(true),
    EnableIPv6: v.literal(false),
    Options: v.record(v.string(), v.string()),
    Containers: v.record(id, v.unknown()),
});
const proxySchema = v.object({
    Id: id,
    Image: imageId,
    Mounts: v.array(v.unknown()),
    Config: v.object({
        User: v.literal("0:0"),
        Entrypoint: v.array(v.string()),
        Cmd: v.nullable(v.array(v.string())),
        Env: v.array(v.string()),
        Healthcheck: v.object({ Test: v.array(v.string()) }),
    }),
    State: v.object({
        Running: v.literal(true),
        Health: v.object({ Status: v.literal("healthy") }),
    }),
    HostConfig: v.object({
        Privileged: v.literal(false),
        ReadonlyRootfs: v.literal(true),
        CapDrop: v.array(v.string()),
        CapAdd: v.array(v.string()),
        SecurityOpt: v.array(v.string()),
        NetworkMode: v.string(),
        PidMode: v.literal(""),
        IpcMode: v.literal("private"),
        Binds: v.nullable(v.array(v.unknown())),
        PortBindings: v.nullable(v.record(v.string(), v.unknown())),
        Sysctls: v.record(v.string(), v.string()),
        Init: v.optional(v.nullable(v.boolean())),
    }),
    NetworkSettings: v.object({ Networks: v.record(v.string(), endpoint) }),
});
function equal(left: unknown, right: unknown) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function fail(): never {
    throw new Error("The browser's isolated egress network is not ready or has changed.");
}

/**
 * Verify one preprovisioned private slot and the exact, healthy, immutable proxy serving it.
 * @param call - Fixed local Engine transport owned by the host; never a model endpoint.
 * @param input - Installed network, proxy container and proxy image identities.
 * @param browserId - This reservation's sole permitted browser, if already created.
 * @returns Completion only when the slot has no other peers and the proxy uses its baked policy.
 */
export async function verifyBrowserEgress(
    call: BrowserDockerRequest,
    input: BrowserEgress,
    browserId?: string
): Promise<void> {
    const config = v.parse(browserEgressSchema, input);
    if (browserId) v.parse(id, browserId);
    const [networkReply, proxyReply, imageReply] = await Promise.all([
        call("GET", `/networks/${config.networkId}`),
        call("GET", `/containers/${config.proxyId}/json`),
        call("GET", `/images/${config.proxyImageId}/json`),
    ]);
    if ([networkReply, proxyReply, imageReply].some((reply) => reply.status !== 200))
        fail();
    const network = v.parse(networkSchema, networkReply.body);
    const proxy = v.parse(proxySchema, proxyReply.body);
    const image = v.parse(
        v.object({ Id: imageId, Config: v.object({ Env: v.array(v.string()) }) }),
        imageReply.body
    );
    const peers = Object.keys(network.Containers).toSorted();
    const expected = [config.proxyId, ...(browserId ? [browserId] : [])].toSorted();
    const connections = Object.values(proxy.NetworkSettings.Networks);
    const slot = connections.find((item) => item.NetworkID === config.networkId);
    const host = proxy.HostConfig;
    if (
        network.Id !== config.networkId ||
        network.Options["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated" ||
        !equal(peers, expected) ||
        proxy.Id !== config.proxyId ||
        proxy.Image !== config.proxyImageId ||
        image.Id !== config.proxyImageId ||
        proxy.Mounts.length > 0 ||
        (host.Binds?.length ?? 0) > 0 ||
        Object.keys(host.PortBindings ?? {}).length > 0 ||
        host.Init ||
        !equal(host.CapDrop, ["ALL"]) ||
        !equal(
            host.CapAdd.map((capability) => capability.replace(/^CAP_/, "")).toSorted(),
            ["NET_ADMIN", "SETGID", "SETPCAP", "SETUID"]
        ) ||
        !equal(host.SecurityOpt, ["no-new-privileges:true"]) ||
        host.Sysctls["net.ipv4.ip_forward"] !== "0" ||
        ["host", "none", "default"].includes(host.NetworkMode) ||
        host.NetworkMode.startsWith("container:") ||
        connections.length !== 2 ||
        !slot?.Aliases?.includes("mira-egress") ||
        slot.DriverOpts?.["com.docker.network.endpoint.ifname"] !== "browser" ||
        !equal(proxy.Config.Entrypoint, ["/usr/local/bin/mira-egress"]) ||
        (proxy.Config.Cmd?.length ?? 0) > 0 ||
        !equal(proxy.Config.Env, image.Config.Env) ||
        !equal(proxy.Config.Healthcheck.Test, [
            "CMD",
            "/usr/local/bin/mira-egress-health",
        ])
    )
        fail();
    if (browserId) {
        const reply = await call("GET", `/containers/${browserId}/json`);
        if (reply.status !== 200) fail();
        const browser = v.parse(
            v.object({
                Id: id,
                HostConfig: v.object({ NetworkMode: id, Dns: v.array(v.string()) }),
                NetworkSettings: v.object({
                    Networks: v.record(v.string(), v.object({ NetworkID: id })),
                }),
            }),
            reply.body
        );
        if (
            browser.Id !== browserId ||
            browser.HostConfig.NetworkMode !== config.networkId ||
            !equal(browser.HostConfig.Dns, ["127.0.0.1"]) ||
            !equal(
                Object.values(browser.NetworkSettings.Networks).map(
                    (item) => item.NetworkID
                ),
                [config.networkId]
            )
        )
            fail();
    }
}
