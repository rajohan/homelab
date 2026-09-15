import type { IdentityClient } from "./api/IdentityClient";
import type { AccountSnapshot } from "./api/schemas";
export type ConfirmationAction =
    | "recovery"
    | "others"
    | "all"
    | {
          readonly kind: "remove";
          readonly factorKind: "webauthn" | "totp";
          readonly id: string;
          readonly label: string;
      }
    | {
          readonly kind: "session";
          readonly id: string;
          readonly label: string;
          readonly current?: boolean;
      };
export type AccountAction =
    | "disable-mfa"
    | "password"
    | "email"
    | "totp"
    | "webauthn"
    | ConfirmationAction;
export type AccountSection =
    | "profile"
    | "password"
    | "keys"
    | "authenticators"
    | "recovery"
    | "disable-mfa"
    | "sessions";
export interface AccountNotice {
    readonly section: AccountSection;
    readonly message: string;
}
export interface AccountPanelProps {
    readonly notice?: string | undefined;
    readonly data: AccountSnapshot;
    readonly onAction: (action: AccountAction) => void;
}
export interface AccountDialogProps {
    readonly client: IdentityClient;
    readonly onClose: () => void;
    readonly onComplete: (message: string) => Promise<void>;
}
