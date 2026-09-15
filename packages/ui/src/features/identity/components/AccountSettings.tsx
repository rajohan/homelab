import { Button, Card, ErrorNotice, LoadingState, PageHeader } from "../../../index";
import type { IdentityClient } from "../api/IdentityClient";
import { IdentityError } from "../api/IdentityError";
import { useAccountSettings } from "../hooks/useAccountSettings";
import { AccountActionDialog } from "./dialogs/AccountActionDialog";
import { RecoveryCodesDialog } from "./dialogs/RecoveryCodesDialog";
import { AccountIdentityPanel } from "./panels/AccountIdentityPanel";
import { ActivityPanel } from "./panels/ActivityPanel";
import { ApprovedApplicationsPanel } from "./panels/ApprovedApplicationsPanel";
import { AuthenticatorAppsPanel } from "./panels/AuthenticatorAppsPanel";
import { DisableMfaPanel } from "./panels/DisableMfaPanel";
import { PasswordPanel } from "./panels/PasswordPanel";
import { ProfilePanel } from "./panels/ProfilePanel";
import { RecoveryCodesPanel } from "./panels/RecoveryCodesPanel";
import { SecurityKeysPanel } from "./panels/SecurityKeysPanel";
import { SessionsPanel } from "./panels/SessionsPanel";
import { SecurityPrompt } from "./verification/SecurityPrompt";
/**
 * Load account security settings and coordinate dialogs, notices and session changes.
 * @returns The component's rendered content for its current state.
 */
export function AccountSettings({
    client,
    signInPath = "/login",
}: {
    client: IdentityClient;
    signInPath?: string;
}) {
    const state = useAccountSettings(client),
        { account } = state;
    if (account.isPending) return <LoadingState label="Loading account settings…" />;
    if (account.isError)
        return (
            <Card className="space-y-4">
                <h1 className="text-2xl font-semibold">Account settings</h1>
                <ErrorNotice error={account.error} />
                {account.error instanceof IdentityError &&
                account.error.status === 401 ? (
                    <a href={signInPath} className="text-accent-300 underline">
                        Sign in to continue
                    </a>
                ) : (
                    <Button onClick={() => void account.refetch()}>Try again</Button>
                )}
            </Card>
        );
    return (
        <div className="w-full space-y-4">
            <PageHeader
                title="Account settings"
                description="Manage your sign-in details, two-factor authentication and active sessions."
            />
            <AccountIdentityPanel username={account.data.user.username} />
            <div className="grid items-start gap-4 xl:grid-cols-2">
                <SecurityKeysPanel
                    data={account.data}
                    onAction={state.setAction}
                    notice={
                        state.notice?.section === "keys"
                            ? state.notice.message
                            : undefined
                    }
                />
                <AuthenticatorAppsPanel
                    data={account.data}
                    onAction={state.setAction}
                    notice={
                        state.notice?.section === "authenticators"
                            ? state.notice.message
                            : undefined
                    }
                />
            </div>
            <RecoveryCodesPanel
                data={account.data}
                onAction={state.setAction}
                notice={
                    state.notice?.section === "recovery"
                        ? state.notice.message
                        : undefined
                }
            />
            <PasswordPanel
                data={account.data}
                onAction={state.setAction}
                notice={
                    state.notice?.section === "password"
                        ? state.notice.message
                        : undefined
                }
            />
            <ProfilePanel
                data={account.data}
                onAction={state.setAction}
                notice={
                    state.notice?.section === "profile" ? state.notice.message : undefined
                }
            />
            <SessionsPanel
                data={account.data}
                onAction={state.setAction}
                notice={
                    state.notice?.section === "sessions"
                        ? state.notice.message
                        : undefined
                }
            />
            <ApprovedApplicationsPanel
                data={account.data}
                onAction={state.setAction}
                notice={
                    state.notice?.section === "applications"
                        ? state.notice.message
                        : undefined
                }
            />
            <DisableMfaPanel data={account.data} onAction={state.setAction} />
            <ActivityPanel client={client} accountId={account.data.user.id} />
            {state.action !== undefined && (
                <AccountActionDialog
                    action={state.action}
                    client={client}
                    email={account.data.user.email}
                    onClose={state.closeAction}
                    onComplete={state.refresh}
                    onRecoveryCodes={state.setRecovery}
                />
            )}
            {state.recovery && (
                <RecoveryCodesDialog
                    codes={state.recovery}
                    onClose={() => state.setRecovery(undefined)}
                />
            )}
            <SecurityPrompt client={client} />
        </div>
    );
}
