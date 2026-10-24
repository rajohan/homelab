import { expect, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Markdown } from "./Markdown";

test("untrusted Markdown retains readable code and tables without active HTML or remote images", () => {
    const view = render(
        <Markdown>{`# Synthetic report

[Unsafe](javascript:alert(1))

![Tracking image](https://untrusted.example/pixel.png)

<img src="https://untrusted.example/raw.png" onerror="alert(1)">

<script>alert(1)</script>

\`\`\`sh
echo '<script>literal</script>'
\`\`\`

| Item | State |
| --- | --- |
| Synthetic | Ready |`}</Markdown>
    );
    try {
        expect(
            screen.getByRole("heading", { name: "Synthetic report" })
        ).toBeInTheDocument();
        expect(view.container.querySelectorAll("img,script,iframe")).toHaveLength(0);
        expect(screen.getByText("Unsafe").getAttribute("href") ?? "").not.toMatch(
            /^javascript:/i
        );
        expect(view.container.querySelector("code")?.textContent).toContain(
            "<script>literal</script>"
        );
        expect(screen.getByRole("table")).toHaveTextContent("SyntheticReady");
    } finally {
        view.unmount();
    }
});

test("JSON uses the packaged syntax theme and copies the complete source", async () => {
    const user = userEvent.setup();
    const source = '{\n  "ready": true,\n  "attempts": 3\n}\n';
    const view = render(<Markdown>{"```json\n" + source + "```"}</Markdown>);
    try {
        const code = view.container.querySelector("pre code");
        expect(code?.textContent).toBe(source);
        expect(code?.querySelectorAll("span").length).toBeGreaterThan(2);
        expect(view.container.querySelector("pre pre")).toBeNull();
        await user.click(screen.getByRole("button", { name: "Copy json block" }));
        expect(await navigator.clipboard.readText()).toBe(source);
        expect(
            await screen.findByRole("button", { name: "Copy json block (copied)" })
        ).toBeInTheDocument();
    } finally {
        view.unmount();
    }
});

test.each(["unrecognized-language", "json"])(
    "partial and unsupported %s code stays readable",
    (language) => {
        const source = '{"incomplete": [1, 2';
        const view = render(<Markdown>{"```" + language + "\n" + source}</Markdown>);
        try {
            expect(view.container.querySelector("pre code")?.textContent).toContain(
                source
            );
            expect(
                screen.getByRole("button", { name: `Copy ${language} block` })
            ).toBeInTheDocument();
        } finally {
            view.unmount();
        }
    }
);

test("inline code stays inline and long blocks bypass syntax parsing", () => {
    const source = "x".repeat(32_001);
    const view = render(
        <Markdown>{"Use `bun run check`.\n\n```ts\n" + source + "\n```"}</Markdown>
    );
    try {
        expect(view.container.querySelector("p code")?.textContent).toBe("bun run check");
        expect(view.container.querySelector("pre code")?.textContent).toBe(source + "\n");
        expect(view.container.querySelector("pre code span")).toBeNull();
    } finally {
        view.unmount();
    }
});
