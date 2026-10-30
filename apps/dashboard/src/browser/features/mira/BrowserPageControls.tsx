import type {
    MiraBrowserPreview,
    miraBrowserHumanCommandSchema,
} from "@homelab/contracts/miraBrowser";
import { ActionGroup, Button, FormField, Input, Select } from "@homelab/ui";
import { useState } from "react";
import type * as v from "valibot";

type Operation = v.InferOutput<typeof miraBrowserHumanCommandSchema>["operation"];
/**
 * Offer only actions exposed by the latest observed page elements.
 * @returns Bounded human controls; typed text is cleared on submission and never added to Chat.
 */
export function BrowserPageControls({
    preview,
    disabled,
    onCommand,
}: {
    readonly preview: MiraBrowserPreview | null;
    readonly disabled: boolean;
    readonly onCommand: (operation: Operation) => void;
}) {
    const [selected, setSelected] = useState("");
    const [text, setText] = useState("");
    const target = preview?.refs.find((item) => item.ref === selected);
    return (
        <div className="space-y-3">
            <FormField label="Page element">
                <Select
                    value={selected}
                    onChange={setSelected}
                    disabled={disabled}
                    options={[
                        { value: "", label: "Choose an element" },
                        ...(preview?.refs ?? [])
                            .filter(
                                (item) =>
                                    item.actions.includes("click") ||
                                    item.actions.includes("type")
                            )
                            .map((item) => ({
                                value: item.ref,
                                label: `${item.role}: ${item.label || item.ref}`,
                            })),
                    ]}
                />
            </FormField>
            <FormField
                label="Text to enter"
                description="Sent directly to the selected element. Existing text is replaced."
            >
                <Input
                    type="password"
                    autoComplete="off"
                    value={text}
                    maxLength={4000}
                    onChange={(event) => setText(event.target.value)}
                />
            </FormField>
            <ActionGroup>
                {target?.actions.includes("type") && (
                    <Button
                        variant="secondary"
                        disabled={disabled}
                        onClick={() => {
                            const value = text;
                            setText("");
                            onCommand({
                                method: "act",
                                input: {
                                    action: "type",
                                    observationId: preview!.observationId,
                                    ref: target.ref,
                                    text: value,
                                    replace: true,
                                },
                            });
                        }}
                    >
                        Enter text
                    </Button>
                )}
                {target?.actions.includes("click") && (
                    <Button
                        variant="secondary"
                        disabled={disabled}
                        onClick={() =>
                            onCommand({
                                method: "act",
                                input: {
                                    action: "click",
                                    observationId: preview!.observationId,
                                    ref: target.ref,
                                },
                            })
                        }
                    >
                        Click element
                    </Button>
                )}
            </ActionGroup>
        </div>
    );
}
