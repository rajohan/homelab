import { describe, expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Badge, Button, Card } from "./index";

describe("shared UI primitives", () => {
    test("a button supports keyboard focus, Enter and Space activation", async () => {
        const user = userEvent.setup();
        const onClick = mock();
        render(<Button onClick={onClick}>Continue</Button>);
        const button = screen.getByRole("button", { name: "Continue" });

        expect(button).toHaveAttribute("type", "button");
        await user.tab();
        expect(button).toHaveFocus();
        expect(button).toHaveAttribute("data-focus");
        await user.keyboard("{Enter}");
        expect(onClick).toHaveBeenCalledTimes(1);
        await user.keyboard(" ");
        expect(onClick).toHaveBeenCalledTimes(2);
    });

    test("a disabled button cannot activate and is skipped by keyboard focus", async () => {
        const user = userEvent.setup();
        const onClick = mock();
        render(
            <>
                <Button disabled onClick={onClick}>
                    Unavailable
                </Button>
                <Button>Available</Button>
            </>
        );
        const disabled = screen.getByRole("button", { name: "Unavailable" });

        expect(disabled).toBeDisabled();
        expect(disabled).toHaveAttribute("data-disabled");
        await user.click(disabled);
        expect(onClick).not.toHaveBeenCalled();
        await user.tab();
        expect(screen.getByRole("button", { name: "Available" })).toHaveFocus();
    });

    test("semantic containers accept explicit utility overrides", () => {
        render(
            <Card aria-label="Service details" className="bg-slate-50">
                <Badge tone="positive" className="rounded-full">
                    Ready
                </Badge>
            </Card>
        );

        const region = screen.getByRole("region", { name: "Service details" });
        expect(region).toHaveClass("bg-slate-50");
        expect(region).not.toHaveClass("bg-white");
        expect(screen.getByText("Ready")).toHaveClass("rounded-full");
        expect(screen.getByText("Ready")).not.toHaveClass("rounded-md");
    });
});
