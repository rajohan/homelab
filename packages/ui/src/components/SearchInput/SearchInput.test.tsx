import { expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormEvent } from "react";

import { SearchInput } from "./SearchInput";

test("search fields expose a label and clear without submitting, then restore focus", async () => {
    const change = mock();
    const submit = mock((event: FormEvent) => event.preventDefault());
    const view = render(
        <form onSubmit={submit}>
            <SearchInput label="Search services" value="gateway" onChange={change} />
        </form>
    );
    const input = screen.getByRole("searchbox", { name: "Search services" });
    expect(input).toHaveValue("gateway");
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear).toHaveClass(
        "hover:bg-transparent",
        "active:bg-transparent",
        "hover:text-primary-50"
    );
    expect(clear).not.toHaveClass("hover:bg-primary-700", "active:bg-primary-600");
    const user = userEvent.setup();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Clear search" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(change).toHaveBeenLastCalledWith("");
    expect(submit).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    view.rerender(<SearchInput label="Search services" value="" onChange={change} />);
    expect(
        screen.queryByRole("button", { name: "Clear search" })
    ).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "x");
    expect(change).toHaveBeenLastCalledWith("x");
});

test("disabled search prevents edits and clearing while retaining custom labels", async () => {
    const change = mock();
    render(
        <SearchInput
            label="Search services"
            clearLabel="Clear service search"
            value="gateway"
            onChange={change}
            disabled
            placeholder="Search by service name"
            maxLength={50}
        />
    );
    const input = screen.getByRole("searchbox");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("maxlength", "50");
    expect(screen.getByPlaceholderText("Search by service name")).toBe(input);
    const clear = screen.getByRole("button", { name: "Clear service search" });
    expect(clear).toBeDisabled();
    await userEvent.setup().click(clear);
    expect(change).not.toHaveBeenCalled();
});
