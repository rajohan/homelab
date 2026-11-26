import { ActionGroup, Button, Modal } from "@homelab/ui";
import { Download, Info } from "lucide-react";

export interface DesktopDialogState {
    readonly session: number;
    readonly revision: number;
    readonly kind: "offer" | "progress" | "notice";
    readonly title: string;
    readonly detail: string;
}

/** Display a shell-owned update or notice with the dashboard dialog and actions.
 * @returns The dialog for the current Windows operation.
 */
export function DesktopDialog({
    state,
    onAction,
}: {
    readonly state: DesktopDialogState;
    readonly onAction: (action: "dismiss" | "accept") => void;
}) {
    const offer = state.kind === "offer";
    const dismiss = () => onAction("dismiss");
    return (
        <Modal
            title={state.kind === "progress" ? "Homelab update" : state.title}
            icon={state.kind === "notice" ? Info : Download}
            onClose={dismiss}
            footer={
                <ActionGroup>
                    <Button variant={offer ? "secondary" : "primary"} onClick={dismiss}>
                        {{ offer: "Later", progress: "Hide", notice: "Done" }[state.kind]}
                    </Button>
                    {offer && (
                        <Button onClick={() => onAction("accept")}>
                            Update and reopen
                        </Button>
                    )}
                </ActionGroup>
            }
        >
            <output
                data-autofocus
                tabIndex={-1}
                className="block text-sm leading-6 text-primary-200 outline-none"
            >
                {state.kind === "progress" ? state.title : state.detail}
            </output>
        </Modal>
    );
}
