import type { UpdateControl, UpdateItem } from "@homelab/contracts/updates";
import { Button, ConfirmDialog } from "@homelab/ui";
import { ArrowUpCircle } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";
import { updateVersion } from "./updateVersion";

/**
 * Confirm one exact observed update and reveal its accepted job in shared worker activity.
 * @param props - Software observation and server-owned admission state.
 * @returns A manual update action; it never installs merely by opening the dialog.
 */
export function UpdateAction({
    item,
    control,
    disabled,
}: {
    readonly item: UpdateItem;
    readonly control: UpdateControl;
    readonly disabled: boolean;
}) {
    const [intent, setIntent] = useState<{
        target: string;
        item: string;
        revision: string;
        requestId: string;
    }>();
    const operation = useJobOperation((input: NonNullable<typeof intent>, signal) =>
        api.updates.request.mutate(input, { signal })
    );
    return (
        <>
            <Button
                variant="secondary"
                className="w-full"
                disabled={disabled || !control.allowed || operation.isPending}
                title={control.reason ?? undefined}
                onClick={() =>
                    setIntent({
                        target: control.target,
                        item: item.id,
                        revision: control.revision,
                        requestId: crypto.randomUUID(),
                    })
                }
            >
                <ArrowUpCircle className="size-4" aria-hidden="true" /> Update
            </Button>
            {intent && (
                <ConfirmDialog
                    title={`Update ${item.name}?`}
                    description={`Install ${updateVersion(item, "available")}. ${item.kind === "container" ? "The Compose image pin will be updated and the selected service recreated." : "Required dependencies may also be updated."} Services may be interrupted. The host will not restart automatically.${control.change === "major" ? " This is a major upgrade." : ""}`}
                    confirmLabel="Update"
                    variant={control.change === "major" ? "danger" : "primary"}
                    onClose={() => setIntent(undefined)}
                    onConfirm={async () => {
                        if (
                            disabled ||
                            !control.allowed ||
                            control.revision !== intent.revision
                        )
                            throw new Error(
                                "The update changed. Close this dialog and review the current version."
                            );
                        await operation.mutateAsync(intent);
                        setIntent(undefined);
                    }}
                />
            )}
        </>
    );
}
