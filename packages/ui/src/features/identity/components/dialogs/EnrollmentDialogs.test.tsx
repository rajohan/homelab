import { expect, mock, spyOn, test } from "bun:test";

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

import { IdentityClient } from "../../api/IdentityClient";
import { downloadRecoveryCodes } from "../../lib/downloadRecoveryCodes";
import { AuthenticatorDialog } from "./AuthenticatorDialog";
import { DisableMfaDialog } from "./DisableMfaDialog";
import { EmailDialog } from "./EmailDialog";
import { PasswordDialog } from "./PasswordDialog";
import { RecoveryCodesDialog } from "./RecoveryCodesDialog";
import { SecurityKeyDialog } from "./SecurityKeyDialog";

test("authenticator enrollment centers its QR, offers icon copying and cancel without an app link", async () => {
    const client = new IdentityClient();
    const action = spyOn(client, "action").mockResolvedValue({
        token: "fixture-token",
        secret: "SYNTHETIC-SETUP-KEY",
        uri: "otpauth://totp/Fixture?secret=JBSWY3DPEHPK3PXP",
    });
    const close = mock(() => {});
    const view = render(
        <AuthenticatorDialog
            client={client}
            onClose={close}
            onComplete={() => Promise.resolve()}
            onRecoveryCodes={() => {}}
        />
    );
    try {
        expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
        fireEvent.change(screen.getByLabelText("Authenticator name"), {
            target: { value: "Test phone" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
        expect(await screen.findByText("Manual setup key")).toBeVisible();
        expect(
            screen.getByText(
                "Scan the QR code, or enter the setup key manually, then confirm with a code from your authenticator app."
            )
        ).toBeVisible();
        expect(
            screen.queryByRole("link", { name: "Open in an authenticator app" })
        ).not.toBeInTheDocument();
        const qr = screen.getByTitle("Authenticator enrollment QR code");
        expect(qr.closest("svg")?.parentElement?.parentElement).toHaveClass(
            "justify-center"
        );
        const copy = screen.getByRole("button", { name: "Copy setup key" });
        expect(copy.querySelector("svg")).not.toBeNull();
        expect(copy.textContent).toBe("");
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(close).toHaveBeenCalledTimes(1);
        expect(action).toHaveBeenCalledTimes(1);
    } finally {
        view.unmount();
        action.mockRestore();
    }
});

test("recovery codes have individual code surfaces and explicit copy and download actions", async () => {
    const codes = ["fixture-code-one", "fixture-code-two"];
    const close = mock(() => {});
    const view = render(<RecoveryCodesDialog codes={codes} onClose={close} />);
    const objectUrl = spyOn(URL, "createObjectURL").mockReturnValue(
        "blob:synthetic-recovery"
    );
    const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const downloads: Array<{ href: string; filename: string }> = [];
    const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
        function (this: HTMLAnchorElement) {
            downloads.push({ href: this.href, filename: this.download });
        }
    );
    try {
        for (const code of codes) expect(screen.getByText(code).tagName).toBe("CODE");
        expect(screen.getByRole("button", { name: "Copy recovery codes" })).toBeVisible();
        expect(objectUrl).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Download" }));
        expect(downloads).toEqual([
            { href: "blob:synthetic-recovery", filename: "homelab-recovery-codes.txt" },
        ]);
        const blob = objectUrl.mock.calls[0]?.[0];
        if (!(blob instanceof Blob))
            throw new Error("Expected a local recovery-code text file");
        expect(await blob.text()).toContain(codes.join("\n"));
        expect(revoke).toHaveBeenCalledWith("blob:synthetic-recovery");
        click.mockImplementation(() => {
            throw new Error("Synthetic download failure");
        });
        expect(() => downloadRecoveryCodes(codes)).toThrow("Synthetic download failure");
        expect(revoke).toHaveBeenCalledTimes(2);
        fireEvent.click(screen.getByRole("button", { name: "I saved the codes" }));
        await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    } finally {
        view.unmount();
        objectUrl.mockRestore();
        revoke.mockRestore();
        click.mockRestore();
    }
});

test.each([
    ["password", PasswordDialog],
    ["email", EmailDialog],
    ["security key", SecurityKeyDialog],
    ["disable MFA", DisableMfaDialog],
] as const)(
    "%s dialog has an explicit cancel in its shared action group",
    (_name, Dialog) => {
        const client = new IdentityClient();
        const action = spyOn(client, "action");
        const close = mock(() => {});
        const view = render(
            <Dialog
                client={client}
                email="operator@example.test"
                onClose={close}
                onComplete={() => Promise.resolve()}
                onRecoveryCodes={() => {}}
            />
        );
        try {
            const cancel = screen.getByRole("button", { name: "Cancel" });
            const form = cancel.closest("form");
            expect(form).not.toBeNull();
            const submit = form?.querySelector('button[type="submit"]');
            expect(submit).not.toBeNull();
            expect(submit?.parentElement).toBe(cancel.parentElement);
            expect(cancel.parentElement).toHaveClass(
                "flex-col",
                "min-[30rem]:flex-row",
                "[&>button]:w-full"
            );
            expect(cancel.parentElement?.lastElementChild).toBe(
                globalThis.matchMedia("(min-width: 30rem)").matches ? submit : cancel
            );
            fireEvent.click(cancel);
            expect(close).toHaveBeenCalledTimes(1);
            expect(action).not.toHaveBeenCalled();
        } finally {
            view.unmount();
            action.mockRestore();
        }
    }
);

test.each([
    [
        "password",
        PasswordDialog,
        "Change password",
        [
            ["Current password", "current-password-value"],
            ["New password", "replacement-password-value"],
            ["Repeat new password", "replacement-password-value"],
        ],
    ],
    [
        "email",
        EmailDialog,
        "Send verification email",
        [["Email address", "next@example.test"]],
    ],
    [
        "authenticator",
        AuthenticatorDialog,
        "Set up authenticator",
        [["Authenticator name", "Test app"]],
    ],
    [
        "security key",
        SecurityKeyDialog,
        "Register security key",
        [["Key name", "Test key"]],
    ],
] as const)(
    "a pending %s mutation cannot be dismissed and unlocks after failure",
    async (_name, Dialog, submitLabel, fields) => {
        const client = new IdentityClient();
        const pending = Promise.withResolvers<never>();
        const action = spyOn(client, "action").mockImplementation(() => pending.promise);
        const enroll = spyOn(client, "enrollSecurityKey").mockImplementation(
            () => pending.promise
        );
        const close = mock(() => {});
        const view = render(
            <Dialog
                client={client}
                email="operator@example.test"
                onClose={close}
                onComplete={() => Promise.resolve()}
                onRecoveryCodes={() => {}}
            />
        );
        try {
            for (const [label, value] of fields)
                fireEvent.change(screen.getByLabelText(label), { target: { value } });
            const cancel = screen.getByRole("button", { name: "Cancel" });
            const submit = screen.getByRole("button", { name: submitLabel });
            await act(() => {
                fireEvent.click(submit);
                return Promise.resolve();
            });
            expect(cancel).toBeDisabled();
            expect(
                screen.queryByRole("button", { name: "Close dialog" })
            ).not.toBeInTheDocument();
            fireEvent.keyDown(screen.getByRole("dialog"), {
                key: "Escape",
                code: "Escape",
            });
            expect(close).not.toHaveBeenCalled();
            expect(screen.getByRole("dialog")).toBeVisible();
            await act(() => {
                pending.reject(new Error("Synthetic action failure"));
                return Promise.resolve();
            });
            expect(cancel).toBeEnabled();
            expect(screen.getByRole("button", { name: "Close dialog" })).toBeVisible();
            fireEvent.keyDown(screen.getByRole("dialog"), {
                key: "Escape",
                code: "Escape",
            });
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            view.unmount();
            action.mockRestore();
            enroll.mockRestore();
        }
    }
);
