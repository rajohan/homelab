import { Download } from "lucide-react";

import { Button, CopyTextButton, Modal } from "../../../../index";
import { downloadRecoveryCodes } from "../../lib/downloadRecoveryCodes";

/**
 * Display newly issued one-use recovery codes with explicit copy and download actions.
 * @returns A one-time presentation; closing it discards the displayed codes.
 */
export function RecoveryCodesDialog({
    codes,
    onClose,
}: {
    readonly codes: readonly string[];
    readonly onClose: () => void;
}) {
    return (
        <Modal
            title="Save your recovery codes"
            onClose={onClose}
            description="These codes are shown only once. Each code can be used once. Store them offline or in your password manager."
        >
            <ul className="grid min-w-0 grid-cols-1 gap-2">
                {codes.map((code) => (
                    <li key={code}>
                        <code className="block min-w-0 rounded-lg border border-primary-700 bg-primary-900 p-2 text-center font-mono text-sm break-all whitespace-normal text-primary-100 select-all">
                            {code}
                        </code>
                    </li>
                ))}
            </ul>
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <CopyTextButton label="Copy recovery codes" text={codes.join("\n")} />
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => downloadRecoveryCodes(codes)}
                >
                    <Download aria-hidden="true" className="size-4" />
                    Download
                </Button>
                <Button size="sm" onClick={onClose}>
                    I saved the codes
                </Button>
            </div>
        </Modal>
    );
}
