import type { MiraAutomation } from "@homelab/contracts/mira";
import { miraImprovementPolicy } from "@homelab/contracts/miraImprovement";
import {
    ActionGroup,
    Badge,
    Button,
    ErrorNotice,
    Fieldset,
    FormField,
    Textarea,
    LoadingState,
    Modal,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Review or revoke one automation's fixed coding permission independently of its schedule.
 * @returns Shared bounded dialog with explicit scope, resource limits and the current grant state.
 */
export function ImprovementPermission({
    automation,
    onClose,
}: {
    readonly automation: MiraAutomation;
    readonly onClose: () => void;
}) {
    const [reason, setReason] = useState("");
    const query = useQuery({
        queryKey: ["operations", "mira", "improvement-grant", automation.id],
        queryFn: () => api.mira.improvements.grant.query({ id: automation.id }),
    });
    const grant = query.data;
    const blocked = grant?.blocked;
    const resolve = useOperation(() => {
        if (!blocked) throw new Error("No blocked attempt is available to review.");
        return api.mira.improvements.resolve.mutate({
            id: blocked.id,
            reviewed: true,
            reason,
        });
    });
    const save = useOperation((enabled: boolean) => {
        if (!grant) throw new Error("Coding permission has not loaded yet.");
        return api.mira.improvements.allow.mutate({
            automationId: automation.id,
            automationVersion: automation.version,
            version: grant.version,
            enabled,
            policyVersion: miraImprovementPolicy.version,
        });
    });
    const apply = (enabled: boolean) => {
        void save
            .mutateAsync(enabled)
            .then(onClose)
            .catch(() => {});
    };
    const active = grant?.enabled && grant.current;
    return (
        <Modal
            title="Automatic code changes"
            size="wide"
            onClose={onClose}
            dismissible={!save.isPending && !resolve.isPending}
        >
            <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{automation.title}</span>
                    <Badge>{active ? "Allowed" : "Requires permission"}</Badge>
                </div>
                <p className="text-sm leading-6 text-primary-300">
                    Allow this automation to test a small frontend improvement and open a
                    draft PR with Mira. Each change still needs GitHub reviews and your
                    approval before merge.
                </p>
                <Fieldset legend="Scope and limits">
                    <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-primary-300">
                        <li>
                            Dashboard browser code and shared UI components only. Up to
                            ten TypeScript or CSS files, 64 KiB each and 256 KiB total.
                        </li>
                        <li>
                            One fixed Daytona check per run, up to ten minutes. At most
                            two attempts per rolling 24 hours and one workflow at a time.
                        </li>
                        <li>
                            Uses your qualified Daytona account and its credits or
                            billing. No automatic retry of a failed check or uncertain
                            provider action.
                        </li>
                        <li>
                            A draft PR is opened only after successful tests and confirmed
                            sandbox cleanup. No merge, deployment, host restart or
                            credential access.
                        </li>
                    </ul>
                </Fieldset>
                <p className="text-sm leading-6 text-primary-400">
                    Pausing this automation, automatic work, Daytona or GitHub stops
                    further steps. Sandbox cleanup continues. Editing the automation or
                    changing its account or snapshot requires renewed permission.
                </p>
                {query.isPending && <LoadingState label="Loading coding permission…" />}
                {grant && !grant.available && (
                    <p className="text-sm text-primary-300">
                        Qualified Daytona and GitHub integrations must be enabled before
                        allowing code changes.
                    </p>
                )}
                {grant?.enabled && !grant.current && (
                    <p className="text-sm text-primary-300">
                        The automation or integration settings changed. Review the current
                        scope before renewing permission.
                    </p>
                )}
                {blocked && (
                    <Fieldset legend="Blocked attempt">
                        <p className="text-sm text-primary-300">{blocked.reason}</p>
                        <FormField label="Review note">
                            <Textarea
                                value={reason}
                                onChange={(event) => setReason(event.target.value)}
                                rows={3}
                                maxLength={2000}
                            />
                        </FormField>
                        <ActionGroup>
                            <Button
                                variant="secondary"
                                disabled={
                                    !blocked.canClose ||
                                    reason.trim().length < 10 ||
                                    save.isPending
                                }
                                busy={resolve.isPending}
                                onClick={() => {
                                    void resolve
                                        .mutateAsync(undefined)
                                        .then(onClose)
                                        .catch(() => {});
                                }}
                            >
                                Close reviewed attempt
                            </Button>
                        </ActionGroup>
                    </Fieldset>
                )}
                {(query.error ?? save.error ?? resolve.error) && (
                    <ErrorNotice error={query.error ?? save.error ?? resolve.error} />
                )}
                <ActionGroup>
                    {!active && (
                        <Button
                            busy={save.isPending && save.variables === true}
                            disabled={
                                !grant?.available || save.isPending || resolve.isPending
                            }
                            onClick={() => apply(true)}
                        >
                            {grant?.enabled ? "Renew permission" : "Allow code changes"}
                        </Button>
                    )}
                    {grant?.enabled && (
                        <Button
                            variant="secondary"
                            busy={save.isPending && save.variables === false}
                            disabled={save.isPending || resolve.isPending}
                            onClick={() => apply(false)}
                        >
                            Revoke permission
                        </Button>
                    )}
                    <Button
                        variant="secondary"
                        disabled={save.isPending || resolve.isPending}
                        onClick={onClose}
                    >
                        Close
                    </Button>
                </ActionGroup>
            </div>
        </Modal>
    );
}
