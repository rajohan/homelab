import type { AccountAction, AccountDialogProps } from "../../types";
import { AuthenticatorDialog } from "./AuthenticatorDialog";
import { EmailDialog } from "./EmailDialog";
import { PasswordDialog } from "./PasswordDialog";
import { SecurityChangeDialog } from "./SecurityChangeDialog";
import { SecurityKeyDialog } from "./SecurityKeyDialog";

export function AccountActionDialog({
    action,
    email,
    onRecoveryCodes,
    ...props
}: AccountDialogProps & {
    readonly action: AccountAction;
    readonly email: string;
    readonly onRecoveryCodes: (codes: readonly string[]) => void;
}) {
    switch (action) {
        case "password": {
            return <PasswordDialog {...props} />;
        }
        case "email": {
            return <EmailDialog {...props} email={email} />;
        }
        case "webauthn": {
            return <SecurityKeyDialog {...props} onRecoveryCodes={onRecoveryCodes} />;
        }
        case "totp": {
            return <AuthenticatorDialog {...props} onRecoveryCodes={onRecoveryCodes} />;
        }
        default: {
            return (
                <SecurityChangeDialog
                    {...props}
                    action={action}
                    onRecoveryCodes={onRecoveryCodes}
                />
            );
        }
    }
}
