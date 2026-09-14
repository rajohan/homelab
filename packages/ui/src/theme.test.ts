import { describe, expect, test } from "bun:test";

import theme from "../../../tailwind.config";

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
