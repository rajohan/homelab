import { RE2JS } from "re2js";
import * as v from "valibot";

const resourcePattern = v.pipe(
    v.string(),
    v.maxLength(1024),
    v.check(
        (value) => /^(?:\(\?i\))?\^\//.test(value) && !/[\r\n]/.test(value),
        "Resource expressions must begin at an absolute URL path"
    )
);
const resourceRule = v.strictObject({
    resources: v.pipe(v.array(resourcePattern), v.minLength(1), v.maxLength(32)),
    policy: v.picklist(["bypass", "two_factor", "deny"]),
    groups: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
});
export const routeSchema = v.strictObject({
    origin: v.pipe(v.string(), v.url(), v.maxLength(512)),
    publicPaths: v.optional(v.array(v.pipe(v.string(), v.regex(/^\/(?!\/)/))), []),
    publicPrefixes: v.optional(
        v.array(v.pipe(v.string(), v.minLength(2), v.regex(/^\/(?!\/).*\/$/))),
        []
    ),
    resourceRules: v.optional(v.pipe(v.array(resourceRule), v.maxLength(64))),
    groups: v.optional(v.array(v.pipe(v.string(), v.minLength(1))), ["admins"]),
});
export type AccessRoute = v.InferOutput<typeof routeSchema>;

type CompiledRule = {
    readonly patterns: readonly RE2JS[];
    readonly policy: "bypass" | "two_factor" | "deny";
    readonly groups: readonly string[];
};
const compiledRoutes = new WeakMap<AccessRoute, readonly CompiledRule[]>();
function compile(route: AccessRoute): readonly CompiledRule[] {
    const cached = compiledRoutes.get(route);
    if (cached) return cached;
    const rules = (route.resourceRules ?? []).map((rule) => {
        const patterns = rule.resources.map((pattern) => RE2JS.compile(pattern));
        if (
            rule.policy === "bypass" &&
            patterns.some((pattern) => pattern.matcher("/").find())
        )
            throw new Error("A public resource rule cannot bypass the entire origin");
        return { patterns, policy: rule.policy, groups: rule.groups ?? route.groups };
    });
    compiledRoutes.set(route, rules);
    return rules;
}

export function validateResourceRules(route: AccessRoute): void {
    compile(route);
}

/**
 * Resolve a normalized path with first-match-wins, linear-time RE2 rules.
 * @param route - The validated origin policy.
 * @param pathname - The URL path without a query string.
 * @returns Denial for ambiguous paths, or the matching/default authentication policy.
 */
export function resourcePolicy(route: AccessRoute, pathname: string) {
    const denied = { policy: "deny", groups: [] } as const;
    if (pathname.length > 8192 || /%(?:2f|5c|00|25)/i.test(pathname)) return denied;
    let path: string;
    try {
        path = decodeURIComponent(pathname);
    } catch {
        return denied;
    }
    for (const character of path) {
        const code = character.codePointAt(0) ?? 0;
        if (code < 32 || code === 127 || code === 92) return denied;
    }
    for (const rule of compile(route)) {
        if (rule.patterns.some((pattern) => pattern.matcher(path).find()))
            return { policy: rule.policy, groups: rule.groups };
    }
    if (
        route.publicPaths.includes(path) ||
        route.publicPrefixes.some((prefix) => path.startsWith(prefix))
    )
        return { policy: "bypass", groups: [] } as const;
    return { policy: "two_factor", groups: route.groups } as const;
}
