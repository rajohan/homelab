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
        <div className="space-y-6">
            <PageHeader
                title="Account settings"
                description="Manage your Homelab identity, security methods and signed-in devices."
            />
            <nav
                aria-label="Account sections"
                className="flex flex-wrap gap-2 border-b border-primary-700 pb-4 text-sm font-medium text-primary-300 [&_a]:rounded-lg [&_a]:px-3 [&_a]:py-2.5 [&_a]:transition-colors [&_a:hover]:bg-primary-700 [&_a:hover]:text-primary-50"
            >
                <a href="#account-profile">Account</a>
                <a href="#account-security">Security</a>
                <a href="#account-sessions">Sessions</a>
                <a href="#security-activity">Activity</a>
            </nav>
            {state.notice && (
                <output className="block rounded-lg bg-emerald-950 p-4 text-base text-emerald-200">
                    {state.notice}
                </output>
            )}
            <ProfilePanel data={account.data} onAction={state.setAction} />
            <SecurityPanel data={account.data} onAction={state.setAction} />
            <SessionsPanel data={account.data} onAction={state.setAction} />
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
