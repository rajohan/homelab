import { describe, expect, test } from "bun:test";

import { cn } from "@homelab/ui/classNames";

describe("cn", () => {
    test("combines nested arrays and conditional objects while ignoring falsy values", () => {
        expect(
            cn(
                "p-4",
                ["text-sm", ["block", { "font-semibold": true, "opacity-50": false }]],
                false,
                null,
                undefined,
                ""
            )
        ).toBe("p-4 text-sm block font-semibold");
    });

    test("later conflicting utilities win without dropping independent variants", () => {
        expect(
            cn(
                "p-4 text-sm hover:bg-slate-100 focus:bg-slate-50",
                ["p-6", { "text-lg": true }],
                "hover:bg-slate-200"
            )
        ).toBe("focus:bg-slate-50 p-6 text-lg hover:bg-slate-200");
    });

    test("returns an empty string when no classes are supplied", () => {
        expect(cn()).toBe("");
    });
});
