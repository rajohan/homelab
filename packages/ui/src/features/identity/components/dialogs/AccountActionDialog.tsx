import type { AccountAction, AccountDialogProps } from "../../types";
import { AuthenticatorDialog } from "./AuthenticatorDialog";
import { DisableMfaDialog } from "./DisableMfaDialog";
import { EmailDialog } from "./EmailDialog";
import { PasswordDialog } from "./PasswordDialog";
import { SecurityChangeDialog } from "./SecurityChangeDialog";
import { SecurityKeyDialog } from "./SecurityKeyDialog";

/**
 * Select the account dialog for the requested security or profile action.
 * @returns The component's rendered content for its current state.
 */
export function AccountActionDialog({
    action,
    email,
    emailVerified,
    onRecoveryCodes,
    ...props
}: AccountDialogProps & {
    readonly action: AccountAction;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly onRecoveryCodes: (codes: readonly string[]) => void;
}) {
    switch (action) {
        case "disable-mfa": {
            return <DisableMfaDialog {...props} />;
        }
        case "password": {
            return <PasswordDialog {...props} />;
        }
        case "email": {
            return <EmailDialog {...props} email={email} emailVerified={emailVerified} />;
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
