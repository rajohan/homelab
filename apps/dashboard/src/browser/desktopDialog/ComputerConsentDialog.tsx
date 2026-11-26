import { ActionGroup, Button, Checkbox, Modal, Select } from "@homelab/ui";
import { Monitor } from "lucide-react";
import { useState } from "react";

export interface ComputerConsentState {
    readonly kind: "consent";
    readonly active: boolean;
    readonly title: string;
    readonly origin: string;
    readonly detail: string;
    readonly status: string;
    readonly control: boolean;
    readonly pickWindow: boolean;
    readonly foregroundLabel: string;
    readonly windows: readonly { value: string; label: string; disabled: boolean }[];
    readonly selected: string;
}

/** Present the Windows host's request and its local stop control.
 * @returns The shared dialog for choosing, approving or ending access on this PC.
 */
export function ComputerConsentDialog({
    state,
    send,
}: {
    readonly state: ComputerConsentState;
    readonly send: (choice: string) => void;
}) {
    const [target, setTarget] = useState("");
    const [foreground, setForeground] = useState(false);
    const hasTarget =
        !state.pickWindow ||
        state.windows.some((item) => item.value === target && !item.disabled);
    const stop = () => send("stop");
    return (
        <Modal
            title={state.title}
            description={state.origin}
            icon={Monitor}
            onClose={stop}
            footer={
                <ActionGroup>
                    <Button
                        variant={state.active ? "danger" : "secondary"}
                        onClick={stop}
                    >
                        {state.active ? "Stop access" : "Decline"}
                    </Button>
                    {!state.active && (
                        <Button
                            disabled={
                                !hasTarget ||
                                Boolean(state.foregroundLabel && !foreground)
                            }
                            onClick={() =>
                                send(
                                    [
                                        "allow",
                                        state.pickWindow ? target : "screen",
                                        foreground ? "yes" : "no",
                                    ].join(":")
                                )
                            }
                        >
                            {state.control ? "Allow control" : "Allow viewing"}
                        </Button>
                    )}
                </ActionGroup>
            }
        >
            <div className="space-y-4 text-sm leading-6 text-primary-200">
                <p data-autofocus tabIndex={-1} className="outline-none">
                    {state.detail}
                </p>
                {state.pickWindow && !state.active && (
                    <div>
                        <Select
                            label="Window to share"
                            value={target}
                            onChange={setTarget}
                            options={[
                                { value: "", label: "Choose a window", disabled: true },
                                ...state.windows,
                            ]}
                        />
                    </div>
                )}
                {state.selected && (
                    <p className="font-medium wrap-anywhere text-primary-50">
                        {state.selected}
                    </p>
                )}
                {!state.active && state.foregroundLabel && (
                    <div className="flex items-center gap-3">
                        <Checkbox
                            checked={foreground}
                            onChange={setForeground}
                            label={state.foregroundLabel}
                        />
                        <span>{state.foregroundLabel}</span>
                    </div>
                )}
                <p className="text-primary-400">{state.status}</p>
            </div>
        </Modal>
    );
}
