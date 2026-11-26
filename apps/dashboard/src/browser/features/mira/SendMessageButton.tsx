import { IconButton } from "@homelab/ui";
import { ArrowUp } from "lucide-react";

/** Submit the owning composer and expose pending state to assistive technology.
 * @returns An accessible icon submit button.
 */
export function SendMessageButton({
    busy,
    disabled,
}: {
    readonly busy: boolean;
    readonly disabled: boolean;
}) {
    return (
        <IconButton
            type="submit"
            variant="primary"
            icon={ArrowUp}
            label="Send message"
            busy={busy}
            disabled={disabled}
            className="rounded-xl"
        />
    );
}
