import * as v from "valibot";

import { ConfirmDialog } from "../../../../index";
import type { AccountDialogProps, ConfirmationAction } from "../../types";
import { confirmationTitle } from "../../validation/confirmationTitle";

export function SecurityChangeDialog({
    client,
    onClose,
    onComplete,
    action,
    onRecoveryCodes,
}: AccountDialogProps & {
    readonly action: ConfirmationAction;
    readonly onRecoveryCodes: (codes: readonly string[]) => void;
}) {
    return (
        <ConfirmDialog
            title={confirmationTitle(action)}
            onClose={onClose}
            onConfirm={async () => {
                if (typeof action === "object") {
                    await client.action(
                        action.kind === "remove" ? "factor/remove" : "session/revoke",
                        { id: action.id }
                    );
                } else if (action === "recovery") {
                    const result = v.parse(
                        v.object({ recoveryCodes: v.array(v.string()) }),
                        await client.action("recovery/rotate")
                    );
                    onRecoveryCodes(result.recoveryCodes);
                } else {
                    await client.action(
                        action === "all"
                            ? "sessions/revoke-all"
                            : "sessions/revoke-others"
                    );
                }
                await onComplete("The security change was applied.");
            }}
        >
            <p className="mb-4 text-base text-slate-600">
                {action === "recovery"
                    ? "Existing recovery codes will stop working. Save the replacement codes immediately."
                    : "This change takes effect immediately."}
            </p>
        </ConfirmDialog>
    );
}
