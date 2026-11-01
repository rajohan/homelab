import { verifyBrowserEgress } from "../browsing/egress";

const networkId = "a".repeat(64),
    proxyId = "b".repeat(64),
    browserId = "c".repeat(64),
    proxyImageId = `sha256:${"d".repeat(64)}`;
const config = { networkId, proxyId, proxyImageId };
/** Build mutable, valid public-egress Engine responses for isolated regression tests.
 * @returns Fixed identities, response bodies and the real verifier bound to those responses.
 */
export function browserEgressFixture() {
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
        config,
        replies,
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
