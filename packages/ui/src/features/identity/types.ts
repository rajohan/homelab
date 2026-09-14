import type { IdentityClient } from "./api/IdentityClient";
import type { AccountSnapshot } from "./api/schemas";
export type ConfirmationAction =
    | "recovery"
    | "others"
    | "all"
    | {
          readonly kind: "remove" | "session";
          readonly id: string;
          readonly label: string;
      };
export type AccountAction =
    | "password"
    | "email"
    | "totp"
    | "webauthn"
    | ConfirmationAction;
export interface AccountPanelProps {
    readonly data: AccountSnapshot;
    readonly onAction: (action: AccountAction) => void;
}
export interface AccountDialogProps {
    readonly client: IdentityClient;
    readonly onClose: () => void;
    readonly onComplete: (message: string) => Promise<void>;
}
