import { expect, test } from "bun:test";

import * as v from "valibot";

import { resourcePolicy, routeSchema, validateResourceRules } from "./accessPolicy";

const policy = v.parse(
    v.object({ routes: v.array(routeSchema) }),
    Bun.YAML.parse(
        await Bun.file(
            new URL("../../../config/access-policy.homelab.yml", import.meta.url)
        ).text()
    )
);

function decision(host: string, path: string) {
    const route = policy.routes.find((item) => item.origin === "https://" + host);
    if (!route) throw new Error("Missing route fixture");
    return resourcePolicy(route, path);
}

test("preserves public Stremio APIs without exposing nested or encoded administration paths", () => {
    for (const host of ["aiostreams", "aiometadata", "comet", "submaker"]) {
        for (const path of [
            "/manifest.json",
            "/token/manifest.json",
            "/uuid/token/manifest.json",
        ])
            expect(decision(host + ".rajohan.no", path).policy).toBe("bypass");
        for (const path of [
            "/",
            "/configure",
            "/x/admin",
            "/x/ADMIN/a",
            "/admin/manifest.json",
            "/%61dmin/manifest.json",
            "/dashboard/stream/a",
        ])
            expect(decision(host + ".rajohan.no", path)).toEqual({
                policy: "two_factor",
                groups: ["admins"],
            });
        for (const path of [
            "/%2fadmin/manifest.json",
            "/%2561dmin/manifest.json",
            "/%5c/manifest.json",
            "/%00",
            "/%zz",
        ])
            expect(decision(host + ".rajohan.no", path).policy).toBe("deny");
    }
    for (const [host, path] of [
        ["aiostreams", "/abc/api/v1/debrid/torbox"],
        ["aiostreams", "/abc/stream/series/tt123:1:2.json"],
        ["aiometadata", "/uuid/catalog/series/list.json"],
        ["comet", "/cometnet/ws"],
        ["comet", "/x/playback/file"],
        ["submaker", "/abc/subtitles/series/episode.json"],
        ["proxy", "/proxy/hls/manifest.m3u8"],
        ["proxy", "/_token_Abc-123/proxy/video"],
    ])
        expect(decision(host + ".rajohan.no", path ?? "").policy).toBe("bypass");
    expect(decision("aiostreams.rajohan.no", "/catalog/").policy).toBe("two_factor");
    expect(decision("aiometadata.rajohan.no", "/catalogue/a").policy).toBe("two_factor");
});

test("preserves the three exact Hydra exceptions and protects all ten administration origins", () => {
    for (const path of ["/hydra/status", "/hydra/register", "/hydra/reinstall"])
        expect(decision("aiomanager.home.rajohan.no", path).policy).toBe("bypass");
    expect(decision("aiomanager.home.rajohan.no", "/hydra/status/extra").policy).toBe(
        "two_factor"
    );
    expect(policy.routes.filter((route) => route.origin.includes(".home.")).length).toBe(
        10
    );
    for (const route of policy.routes) {
        validateResourceRules(route);
        expect(resourcePolicy(route, "/").policy).toBe("two_factor");
    }
});

test("rejects root-wide bypass and evaluates explicit denies before public fallbacks", () => {
    const route = v.parse(routeSchema, {
        origin: "https://example.test",
        publicPrefixes: ["/api/"],
        resourceRules: [{ resources: ["^/api/private(?:/.*)?$"], policy: "deny" }],
    });
    expect(resourcePolicy(route, "/api/private/file").policy).toBe("deny");
    expect(resourcePolicy(route, "/api/public").policy).toBe("bypass");
    expect(() =>
        validateResourceRules(
            v.parse(routeSchema, {
                origin: "https://example.test",
                resourceRules: [{ resources: ["^/.*$"], policy: "bypass" }],
            })
        )
    ).toThrow("entire origin");
});

test("fails closed on unsupported or malformed RE2 expressions", () => {
    for (const expression of ["^/(", "^/(?=private)"]) {
        const route = v.parse(routeSchema, {
            origin: "https://example.test",
            resourceRules: [{ resources: [expression], policy: "bypass" }],
        });
        expect(() => validateResourceRules(route)).toThrow();
    }
    expect(decision("proxy.rajohan.no", "/_token_!invalid/proxy/video").policy).toBe(
        "two_factor"
    );
});
