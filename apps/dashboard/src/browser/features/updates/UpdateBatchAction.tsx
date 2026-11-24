import { Button, IconButton } from "@homelab/ui";
import { ArrowUpCircle } from "lucide-react";
import { useState } from "react";

import { UpdateBatchDialog } from "./UpdateBatchDialog";

/**
 * Open an exact update plan for one host or the entire configured inventory.
 * @param props - Optional host scope and current inventory availability.
 * @returns A source action or a button sized by the surrounding action group.
 */
export function UpdateBatchAction({
    source,
    label,
    disabled,
}: {
    readonly source?: string;
    readonly label?: string;
    readonly disabled: boolean;
}) {
    const [open, setOpen] = useState(false);
    return (
        <>
            {source && label ? (
                <IconButton
                    icon={ArrowUpCircle}
                    label={`Update all on ${label}`}
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => setOpen(true)}
                />
            ) : (
                <Button
                    variant="secondary"
                    disabled={disabled}
                    aria-label={label ? `Update all on ${label}` : "Update all hosts"}
                    onClick={() => setOpen(true)}
                >
                    <ArrowUpCircle className="size-4 shrink-0" aria-hidden="true" />{" "}
                    Update all
                </Button>
            )}
            {open && (
                <UpdateBatchDialog
                    {...(source ? { source } : {})}
                    {...(label ? { label } : {})}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
}
