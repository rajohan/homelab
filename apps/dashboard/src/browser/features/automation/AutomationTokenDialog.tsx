import { Button, CopyTextButton, Modal } from "@homelab/ui";

/**
 * Display newly issued bearer material only in the creating browser's transient state.
 * @returns A one-time token panel with explicit copy and dismissal controls.
 */
export function AutomationTokenDialog({
    token,
    onClose,
}: {
    readonly token: string;
    readonly onClose: () => void;
}) {
    return (
        <Modal
            title="Save your access token"
            description="This token is shown only once. Store it privately in Doppler or your password manager. Never place it in a URL."
            onClose={onClose}
        >
            <div className="space-y-4">
                <div className="flex items-start gap-2 rounded-lg border border-primary-700 bg-primary-950/50 p-3">
                    <code className="min-w-0 flex-1 text-sm break-all">{token}</code>
                    <CopyTextButton text={token} label="Copy access token" />
                </div>
                <Button fullWidth onClick={onClose}>
                    Done
                </Button>
            </div>
        </Modal>
    );
}
