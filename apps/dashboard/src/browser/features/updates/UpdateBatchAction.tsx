import { Button } from "@homelab/ui";
import { ArrowUpCircle } from "lucide-react";
import { useState } from "react";

import { UpdateBatchDialog } from "./UpdateBatchDialog";

/**
 * Open an exact update plan for one host or the entire configured inventory.
 * @param props - Optional host scope and current inventory availability.
 * @returns A full-width mobile action; opening it never queues an installation.
 */
export function UpdateBatchAction({
    source,
    label,
    disabled,
    className,
}: {
    readonly source?: string;
    readonly label?: string;
    readonly disabled: boolean;
    readonly className?: string;
}) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                variant="secondary"
                className={`w-full ${className ?? ""}`}
                disabled={disabled}
                aria-label={label ? `Update all on ${label}` : "Update all hosts"}
                onClick={() => setOpen(true)}
            >
                <ArrowUpCircle className="size-4 shrink-0" aria-hidden="true" /> Update
                all
            </Button>
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
