import { describe, expect, test } from "bun:test";

import theme from "../../../tailwind.config.ts";

describe("shared Tailwind configuration", () => {
    test("preserves the reusable palettes and loading keyframes", () => {
        expect(theme.theme.extend.colors.primary[500]).toBe("#686F7B");
        expect(theme.theme.extend.colors.accent[500]).toBe("#5B8CFF");
        expect(theme.theme.extend.keyframes["loading-state-second-dot"]).toEqual({
            "0%, 32%": { opacity: "0" },
            "33%, 100%": { opacity: "1" },
        });
    });

    test("registers the typography plugin", () => {
        expect(theme.plugins).toHaveLength(1);
        expect(theme.plugins[0]).toBeFunction();
    });
});

test("both applications import the shared stylesheet without redefining global rules", async () => {
    for (const app of ["auth", "dashboard"]) {
        const entry = await Bun.file(
            new URL(`../../../apps/${app}/src/styles.css`, import.meta.url)
        ).text();
        expect(entry).toContain('@import "@homelab/ui/styles"');
        expect(entry).toContain('@source "./browser"');
        expect(entry).not.toMatch(/:root|@layer|#[\da-f]{3,8}/i);
    }
    const shared = await Bun.file(new URL("styles/index.css", import.meta.url)).text();
    expect(shared).toContain('@import "./base.css"');
    expect(shared).toContain('@config "../../../../tailwind.config.ts"');
    const base = await Bun.file(new URL("styles/base.css", import.meta.url)).text();
    expect(base).toContain("color-scheme: dark");
    expect(base).toContain('theme("colors.primary.900")');
    expect(base).toContain('theme("colors.primary.50")');
    expect(base).not.toContain("overflow: hidden");
});
