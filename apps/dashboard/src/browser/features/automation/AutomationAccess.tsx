import type { AutomationAccount } from "@homelab/contracts/operations";
import {
    Button,
    Card,
    ConfirmDialog,
    LoadingState,
    SectionHeader,
    VirtualList,
    queryRefresh,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Bot, Plus } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { AutomationAccountCard, type AutomationAction } from "./AutomationAccountCard";
import { AutomationEditor } from "./AutomationEditor";
import { AutomationTokenDialog } from "./AutomationTokenDialog";
import { TokenRotationDialog } from "./TokenRotationDialog";

const confirmation = {
    revoke: { title: "Revoke this token?", label: "Revoke token" },
    disable: { title: "Disable this automation account?", label: "Disable account" },
} as const;

/**
 * Manage scoped automation accounts inside Settings with the existing central step-up flow.
 * @returns Paginated account management, transient token presentation and explicit confirmations.
 */
export function AutomationAccess() {
    const [editor, setEditor] = useState<AutomationAccount | "new">();
    const [token, setToken] = useState<string>();
    const [rotation, setRotation] = useState<AutomationAccount>();
    const [action, setAction] = useState<Exclude<AutomationAction, { kind: "rotate" }>>();
    const inventory = useInfiniteQuery({
        queryKey: ["operations", "automation"],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }) =>
            api.automation.list.query(pageParam ? { before: pageParam } : {}, { signal }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        retry: false,
        ...queryRefresh("slow"),
    });
    const mutation = useOperation(
        async (input: Exclude<AutomationAction, { kind: "rotate" }>, signal) => {
            const reference = { id: input.account.id, version: input.account.version };
            if (input.kind === "revoke")
                return api.automation.revoke.mutate(
                    { ...reference, credentialId: input.credential.id },
                    { signal }
                );
            return api.automation.disable.mutate(reference, { signal });
        }
    );
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Automation access"
                description="Give scripts and services their own limited access to Dashboard APIs."
                icon={Bot}
                actions={
                    <Button
                        size="sm"
                        aria-label="Add automation account"
                        onClick={() => setEditor("new")}
                    >
                        <Plus size={16} aria-hidden="true" />
                        Add
                    </Button>
                }
            />
            {inventory.isPending && <LoadingState label="Loading automation accounts…" />}
            <VirtualList
                label="Automation accounts"
                rows={
                    inventory.data?.pages.flatMap((page) =>
                        page.accounts.map((account) => ({
                            account,
                            credentials: page.credentials.filter(
                                (credential) => credential.accountId === account.id
                            ),
                        }))
                    ) ?? []
                }
                getKey={(row) => row.account.id}
                continuation={{
                    hasMore: inventory.hasNextPage,
                    loading: inventory.isFetching,
                    error: inventory.isError ? inventory.error : undefined,
                    loadingLabel: "Loading more accounts…",
                    onLoadMore: () =>
                        void (inventory.isRefetchError
                            ? inventory.refetch()
                            : inventory.fetchNextPage()),
                }}
                renderItem={({ account, credentials }) => (
                    <AutomationAccountCard
                        key={account.id}
                        account={account}
                        credentials={credentials}
                        onEdit={() => setEditor(account)}
                        onAction={(next) =>
                            next.kind === "rotate"
                                ? setRotation(next.account)
                                : setAction(next)
                        }
                    />
                )}
            />
            {inventory.data?.pages[0]?.accounts.length === 0 && (
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    No automation accounts. Create one when a script or service needs
                    access.
                </p>
            )}
            {editor && (
                <AutomationEditor
                    {...(editor === "new" ? {} : { account: editor })}
                    onClose={() => setEditor(undefined)}
                    onToken={(value) => {
                        setEditor(undefined);
                        setToken(value);
                    }}
                />
            )}
            {token && (
                <AutomationTokenDialog
                    token={token}
                    onClose={() => setToken(undefined)}
                />
            )}
            {rotation && (
                <TokenRotationDialog
                    account={rotation}
                    onClose={() => setRotation(undefined)}
                    onToken={(value) => {
                        setRotation(undefined);
                        setToken(value);
                    }}
                />
            )}
            {action && (
                <ConfirmDialog
                    title={confirmation[action.kind].title}
                    description="Affected clients will lose API access. Your browser session is not affected."
                    confirmLabel={confirmation[action.kind].label}
                    variant="danger"
                    onClose={() => setAction(undefined)}
                    onConfirm={async () => {
                        await mutation.mutateAsync(action);
                        setAction(undefined);
                    }}
                />
            )}
        </Card>
    );
}
