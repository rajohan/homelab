import { Button, CopyTextButton, FieldsForm, Modal, formatDateTime } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Issue a short-lived ticket through fresh human verification and keep it only in dialog state.
 * @returns Shared pairing form and one-time copy panel; closing discards the ticket from the browser.
 */
export function ComputerPairDialog({ onClose }: { readonly onClose: () => void }) {
    const [ticket, setTicket] = useState<{ token: string; expiresAt: string }>();
    const pair = useOperation(async (label: string, signal) => {
        const result = await api.mira.computers.pair.mutate({ label }, { signal });
        setTicket({ token: result.token, expiresAt: result.expiresAt });
        // The mutation cache must not retain the one-time secret after this dialog closes.
    });
    return (
        <Modal
            title="Pair a computer"
            description={
                ticket
                    ? "Enter this code in the Mira companion on your computer. Keep it private."
                    : "Give this computer a name you will recognize."
            }
            onClose={onClose}
            dismissible={!pair.isPending}
        >
            {ticket ? (
                <div className="space-y-4">
                    <div className="flex items-start gap-2 rounded-lg border border-primary-700 bg-primary-950/40 p-3">
                        <code className="min-w-0 flex-1 text-sm break-all">
                            {ticket.token}
                        </code>
                        <CopyTextButton text={ticket.token} label="Copy pairing code" />
                    </div>
                    <p className="text-sm text-primary-400">
                        Single use · Expires {formatDateTime(ticket.expiresAt)}
                    </p>
                    <p className="text-sm text-primary-300">
                        Pairing connects this computer to your account. Screen and input
                        access require a separate permission.
                    </p>
                    <Button fullWidth onClick={onClose}>
                        Done
                    </Button>
                </div>
            ) : (
                <FieldsForm
                    fields={[{ name: "label", label: "Computer name", maximum: 80 }]}
                    submitLabel="Create pairing code"
                    onCancel={onClose}
                    onSubmit={async (values) => {
                        await pair.mutateAsync(values.label ?? "");
                    }}
                />
            )}
        </Modal>
    );
}
