import { expect, test } from "bun:test";

import { parseComputerBinding, privateComputerAddress } from "./computer";

test("computer listener is opt-in and refuses wildcard, public and ambiguous bindings", () => {
    expect(parseComputerBinding({})).toBeUndefined();
    for (const hostname of [
        "127.0.0.1",
        "10.77.20.2",
        "172.16.1.1",
        "192.168.1.5",
        "100.64.0.1",
        "100.127.255.254",
    ])
        expect(
            parseComputerBinding({
                HOMELAB_MIRA_COMPUTER_HOST: hostname,
                HOMELAB_MIRA_COMPUTER_PORT: "3113",
            })
        ).toEqual({ hostname, port: 3113 });
    for (const hostname of [
        "0.0.0.0",
        "::",
        "::1",
        "::ffff:127.0.0.1",
        "8.8.8.8",
        "100.128.1.1",
        "100.63.1.1",
        "172.32.0.1",
        "localhost",
        "127.1",
    ])
        expect(() => privateComputerAddress(hostname)).toThrow();
    for (const values of [
        { HOMELAB_MIRA_COMPUTER_HOST: "127.0.0.1" },
        { HOMELAB_MIRA_COMPUTER_PORT: "3113" },
        { HOMELAB_MIRA_COMPUTER_HOST: "127.0.0.1", HOMELAB_MIRA_COMPUTER_PORT: "65536" },
    ])
        expect(() => parseComputerBinding(values)).toThrow();
});
