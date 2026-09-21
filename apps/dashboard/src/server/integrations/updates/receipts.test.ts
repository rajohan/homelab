import { expect, test } from "bun:test";

import type { ApplicationTarget } from "../applications/configuration";
import { updateResourceKeys, type UpdateTarget } from "./configuration";
import { updateReceiptResourceKeys, updateReceiptScope } from "./receipts";

function docker(source: string, host: string): UpdateTarget {
    return {
        id: source,
        source,
        label: source,
        host,
        user: "updater",
        port: 22,
        identityFile: "/run/secrets/test-key",
        knownHostsFile: "/run/secrets/test-hosts",
        sudo: false,
        driver: {
            kind: "docker",
            name: source,
            project: "demo",
            service: source,
            directory: "/srv/demo",
            file: "/srv/demo/compose.yaml",
            imageFile: "/srv/demo/compose.yaml",
        },
    };
}

const connected = [
    docker("alpha", "first.invalid"),
    docker("beta", "FIRST.invalid"),
    docker("gamma", "second.invalid"),
    docker("delta", "second.invalid"),
    docker("epsilon", "third.invalid"),
    docker("zeta", "fourth.invalid"),
];
const unrelated = docker("unrelated", "elsewhere.invalid");
const aptBridge: UpdateTarget = {
    ...docker("apt-only", "second.invalid"),
    driver: { kind: "apt" },
};
const applications: ApplicationTarget[] = [
    ["beta", "gamma", "snapshot-only"],
    ["delta", "epsilon"],
    ["epsilon", "zeta", "snapshot-only"],
    ["unrelated", "apt-only"],
].map((updateSources, index) => ({
    id: `docker-${index}`,
    label: "Docker",
    endpoint: "https://docker.invalid",
    projects: ["demo"],
    updateSources,
}));

test.each(
    connected.flatMap(({ source }) =>
        [false, true].map((reverse) => ({ source, reverse }))
    )
)(
    "receipt closure and leases are symmetric across alternating host bindings: %j",
    ({ source, reverse }) => {
        const target = connected.find((candidate) => candidate.source === source)!;
        const targets = [...connected, unrelated, aptBridge];
        const bindings = [...applications];
        if (reverse) {
            targets.reverse();
            bindings.reverse();
        }
        const scope = updateReceiptScope(target, targets, bindings);
        expect(scope.sources).toEqual([
            "alpha",
            "beta",
            "delta",
            "epsilon",
            "gamma",
            "snapshot-only",
            "zeta",
        ]);
        expect(scope.targets.map((candidate) => candidate.id).toSorted()).toEqual(
            connected.map((candidate) => candidate.id).toSorted()
        );
        expect(updateReceiptResourceKeys(scope)).toEqual(
            [
                ...new Set(
                    connected.flatMap((candidate) => updateResourceKeys(candidate))
                ),
            ].toSorted()
        );
    }
);

test("non-Docker updates do not expand receipt scope through host or application bindings", () => {
    const scope = updateReceiptScope(
        aptBridge,
        [...connected, unrelated, aptBridge],
        applications
    );
    expect(scope.sources).toEqual(["apt-only"]);
    expect(scope.targets).toEqual([aptBridge]);
    expect(updateReceiptResourceKeys(scope)).toEqual(
        updateResourceKeys(aptBridge).toSorted()
    );
});

test("a source-only lifecycle binding does not infer aliases from endpoint or labels", () => {
    const target = connected[0]!;
    const scope = updateReceiptScope(
        target,
        [target, unrelated],
        [
            {
                id: target.source,
                label: unrelated.source,
                endpoint: `https://${unrelated.host}`,
                projects: ["demo"],
            },
        ]
    );
    expect(scope.sources).toEqual([target.source]);
    expect(scope.targets).toEqual([target]);
});
