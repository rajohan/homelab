import type {
    AutomationAccount,
    AutomationCredential,
} from "@homelab/contracts/operations";
import { ActionGroup, Badge, Button, Card, formatDateTime } from "@homelab/ui";

export type AutomationAction =
    | { kind: "rotate"; account: AutomationAccount }
    | { kind: "disable"; account: AutomationAccount }
    | { kind: "revoke"; account: AutomationAccount; credential: AutomationCredential };

/**
 * Show a machine account and its bounded credential inventory without bearer material.
 * @returns Account permissions, credential lifecycle details and explicit management actions.
 */
export function AutomationAccountCard({
    account,
    credentials,
    onEdit,
    onAction,
}: {
    readonly account: AutomationAccount;
    readonly credentials: readonly AutomationCredential[];
    readonly onEdit: () => void;
    readonly onAction: (action: AutomationAction) => void;
}) {
    return (
        <Card className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">{account.label}</h3>
                <Badge tone={account.disabledAt ? "neutral" : "positive"}>
                    {account.disabledAt ? "Disabled" : "Active"}
                </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
                {account.capabilities.map((capability) => (
                    <Badge key={capability}>{capability}</Badge>
                ))}
            </div>
            <div className="max-h-72 space-y-2 overflow-auto">
                {credentials.map((credential) => (
                    <div
                        key={credential.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary-700 bg-primary-950/40 p-3"
                    >
                        <div className="min-w-0 grow basis-64 text-sm">
                            <p className="font-mono">{credential.prefix.slice(0, 13)}…</p>
                            <p className="text-primary-400">
                                Created {formatDateTime(credential.createdAt)}
                            </p>
                            <p className="text-primary-400">
                                {credential.lastUsedAt
                                    ? `Last used ${formatDateTime(credential.lastUsedAt)}`
                                    : "Not used yet"}
                            </p>
                            <p className="text-primary-400">
                                {credential.expiresAt
                                    ? `Expires ${formatDateTime(credential.expiresAt)}`
                                    : "No expiry"}
                            </p>
                        </div>
                        {credential.revokedAt ? (
                            <Badge>Revoked</Badge>
                        ) : (
                            !account.disabledAt && (
                                <Button
                                    variant="danger"
                                    size="sm"
                                    className="grow basis-32"
                                    onClick={() =>
                                        onAction({ kind: "revoke", account, credential })
                                    }
                                >
                                    Revoke token
                                </Button>
                            )
                        )}
                    </div>
                ))}
            </div>
            {!account.disabledAt && (
                <ActionGroup>
                    <Button onClick={() => onAction({ kind: "rotate", account })}>
                        Create replacement token
                    </Button>
                    <Button variant="secondary" onClick={onEdit}>
                        Edit permissions
                    </Button>
                    <Button
                        variant="danger"
                        onClick={() => onAction({ kind: "disable", account })}
                    >
                        Disable account
                    </Button>
                </ActionGroup>
            )}
        </Card>
    );
}
