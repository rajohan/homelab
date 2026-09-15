import { expect, mock, spyOn, test } from "bun:test";

import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { IdentityClient } from "../../api/IdentityClient";
import { downloadRecoveryCodes } from "../../lib/downloadRecoveryCodes";
import { AuthenticatorDialog } from "./AuthenticatorDialog";
import { RecoveryCodesDialog } from "./RecoveryCodesDialog";

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
