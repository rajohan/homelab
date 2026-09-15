import { Button, Card, ErrorNotice, LoadingState, PageHeader } from "../../../index";
import type { IdentityClient } from "../api/IdentityClient";
import { IdentityError } from "../api/IdentityError";
import { useAccountSettings } from "../hooks/useAccountSettings";
import { AccountActionDialog } from "./dialogs/AccountActionDialog";
import { RecoveryCodesDialog } from "./dialogs/RecoveryCodesDialog";
import { ActivityPanel } from "./panels/ActivityPanel";
import { ProfilePanel } from "./panels/ProfilePanel";
import { SecurityPanel } from "./panels/SecurityPanel";
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
        <div className="mx-auto w-full max-w-5xl space-y-4">
            <PageHeader
                title="Account settings"
                description="Manage your sign-in details, two-factor authentication and active sessions."
            />
            <ProfilePanel
                data={account.data}
                onAction={state.setAction}
                notice={
                    state.notice?.section === "profile" ? state.notice.message : undefined
                }
            />
            <SecurityPanel
                data={account.data}
                onAction={state.setAction}
                notice={
                    state.notice?.section === "security"
                        ? state.notice.message
                        : undefined
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
            <ActivityPanel data={account.data} onAction={state.setAction} />
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
