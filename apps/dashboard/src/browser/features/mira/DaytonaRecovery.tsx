import {
    ActionGroup,
    Button,
    Card,
    Checkbox,
    ErrorNotice,
    FormField,
    Input,
    LoadingState,
    Modal,
    SectionHeader,
    Textarea,
    formatDateTime,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Cloud } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Review the original sandbox and record an explicit external cleanup verification.
 * @param props - Owned job and return action.
 * @returns A bounded recovery dialog; no provider calls or automatic re-enabling.
 */
export function DaytonaRecovery({
    id,
    onClose,
}: {
    readonly id: string;
    readonly onClose: () => void;
}) {
    const query = useQuery({
        queryKey: ["operations", "mira", "daytona", "recovery", id],
        queryFn: () => api.mira.daytona.recovery.query({ id }),
        refetchInterval: 3000,
    });
    const [name, setName] = useState("");
    const [reason, setReason] = useState("");
    const [inspected, setInspected] = useState(false);
    const [reviewedHash, setReviewedHash] = useState<string | null>(null);
    const recovery = query.data;
    const changed = reviewedHash !== null && reviewedHash !== recovery?.identityHash;
    const resolve = useOperation(() => {
        if (!recovery || !inspected || !reviewedHash)
            throw new Error("Review the original sandbox first.");
        return api.mira.daytona.resolveCleanup.mutate({
            id,
            identityHash: reviewedHash,
            sandboxName: name,
            reason,
            accountInspected: true,
        });
    });
    return (
        <Modal
            title="Sandbox cleanup"
            onClose={onClose}
            dismissible={!resolve.isPending}
            size="wide"
        >
            <form
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void resolve
                        .mutateAsync(undefined)
                        .then(onClose)
                        .catch(() => {});
                }}
            >
                {query.isPending && <LoadingState label="Loading sandbox identity" />}
                {recovery && (
                    <>
                        <Card className="space-y-4 bg-primary-900/40">
                            <SectionHeader title="Original sandbox" icon={Cloud} />
                            <dl className="grid gap-3 text-sm sm:grid-cols-2">
                                {[
                                    ["Organization", recovery.organizationId],
                                    ["Region", recovery.target],
                                    ["Snapshot", recovery.snapshotId],
                                    ["Sandbox ID", recovery.sandboxId ?? "Not received"],
                                    ["Sandbox name", recovery.sandboxName],
                                ].map(([label, value]) => (
                                    <div key={label} className="min-w-0">
                                        <dt className="text-primary-400">{label}</dt>
                                        <dd className="wrap-anywhere">{value}</dd>
                                    </div>
                                ))}
                                {recovery.eligibleAt && (
                                    <div>
                                        <dt className="text-primary-400">
                                            Recovery available after
                                        </dt>
                                        <dd>{formatDateTime(recovery.eligibleAt)}</dd>
                                    </div>
                                )}
                            </dl>
                        </Card>
                        {recovery.resolution ? (
                            <Card className="space-y-3 bg-primary-900/40">
                                <SectionHeader
                                    title="Operator confirmation"
                                    icon={Cloud}
                                />
                                <p className="text-sm text-primary-300">
                                    {recovery.resolution.actor} ·{" "}
                                    {formatDateTime(recovery.resolution.at)}
                                </p>
                                <p className="text-sm wrap-anywhere whitespace-pre-wrap">
                                    {recovery.resolution.reason}
                                </p>
                            </Card>
                        ) : (
                            <>
                                <p className="text-sm text-primary-300">
                                    Check this original organization in Daytona and remove
                                    the sandbox if it exists. Confirm only after you have
                                    verified it is gone and no creation is pending. This
                                    records your verification and stops automatic cleanup
                                    checks. It does not delete a sandbox or prove the job
                                    succeeded. Daytona stays paused.
                                </p>
                                {recovery.blockedReason && (
                                    <p className="text-sm text-primary-300">
                                        {recovery.blockedReason}
                                    </p>
                                )}
                                {changed && (
                                    <p className="text-sm text-primary-300">
                                        The sandbox identity changed. Close and review it
                                        again.
                                    </p>
                                )}
                                <FormField label="Sandbox name confirmation">
                                    <Input
                                        value={name}
                                        onChange={(event) => {
                                            setName(event.target.value);
                                            setReviewedHash(
                                                (previous) =>
                                                    previous ?? recovery.identityHash
                                            );
                                        }}
                                        required
                                        maxLength={100}
                                        disabled={resolve.isPending}
                                    />
                                </FormField>
                                <FormField
                                    label="Verification note"
                                    description="Describe where and how you verified removal. Do not include credentials."
                                >
                                    <Textarea
                                        value={reason}
                                        onChange={(event) =>
                                            setReason(event.target.value)
                                        }
                                        rows={4}
                                        required
                                        minLength={10}
                                        maxLength={2000}
                                        disabled={resolve.isPending}
                                    />
                                </FormField>
                                <div className="flex items-start gap-3 text-sm">
                                    <Checkbox
                                        label="I verified cleanup in the original Daytona organization"
                                        checked={inspected}
                                        onChange={(value) => {
                                            setInspected(value);
                                            setReviewedHash(
                                                (previous) =>
                                                    previous ?? recovery.identityHash
                                            );
                                        }}
                                        disabled={resolve.isPending}
                                    />
                                    <span>
                                        I verified cleanup in the original Daytona
                                        organization.
                                    </span>
                                </div>
                            </>
                        )}
                    </>
                )}
                {(query.error || resolve.error) && (
                    <ErrorNotice error={query.error ?? resolve.error} />
                )}
                <ActionGroup>
                    {recovery && !recovery.resolution && (
                        <Button
                            type="submit"
                            busy={resolve.isPending}
                            disabled={
                                resolve.isPending ||
                                query.isError ||
                                !!recovery.blockedReason ||
                                changed ||
                                !inspected ||
                                name !== recovery.sandboxName ||
                                reason.trim().length < 10
                            }
                        >
                            Confirm external cleanup
                        </Button>
                    )}
                    <Button
                        variant="secondary"
                        onClick={onClose}
                        disabled={resolve.isPending}
                    >
                        Close
                    </Button>
                </ActionGroup>
            </form>
        </Modal>
    );
}
