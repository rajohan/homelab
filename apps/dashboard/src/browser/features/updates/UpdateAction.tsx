import type { UpdateControl, UpdateItem } from "@homelab/contracts/updates";
import { Button } from "@homelab/ui";
import { ArrowUpCircle } from "lucide-react";
import { useState } from "react";

import { UpdateDialog } from "./UpdateDialog";

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
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                variant="secondary"
                className="w-full"
                disabled={disabled || !control.allowed}
                title={control.reason ?? undefined}
                onClick={() => setOpen(true)}
            >
                <ArrowUpCircle className="size-4" aria-hidden="true" /> Update
            </Button>
            {open && (
                <UpdateDialog
                    item={item}
                    target={control.target}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
}
