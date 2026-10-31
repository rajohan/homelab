import type { DeploymentPolicySummary } from "@homelab/contracts/deployment";
import { Badge, Button, ErrorNotice, formatDateTime } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { DeploymentPauseDialog } from "./DeploymentPauseDialog";
import { DeploymentPolicyDialog } from "./DeploymentPolicyDialog";

/**
 * Show one target's automatic deployment policy and independent pause controls.
 * @param props - Public policy summary from the deployment overview.
 * @returns Responsive actions and explicit pause or configuration-change status.
 */
export function DeploymentPolicyControl({
    policy,
}: {
    readonly policy: DeploymentPolicySummary;
}) {
    const [dialog, setDialog] = useState<"edit" | "pause">();
    const resume = useOperation((_input: void, signal) =>
        api.releases.deployment.pause.mutate(
            {
                target: policy.target,
                version: policy.version,
                paused: false,
                reason: null,
                until: null,
            },
            { signal }
        )
    );
    const modes = {
        manual: "Manual",
        patch: "Automatic patches",
        minor: "Automatic patch and minor",
    };
    let label = modes[policy.mode];
    if (policy.paused) label = "Paused";
    if (policy.configurationChanged) label = "Review policy";
    return (
        <div className="space-y-3 border-t border-primary-700 pt-3">
            <div className="grid items-center gap-3 @min-[40rem]/deployment:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-primary-200">
                            Deployment policy
                        </span>
                        <Badge tone={policy.configurationChanged ? "warning" : "neutral"}>
                            {label}
                        </Badge>
                    </div>
                    {policy.configurationChanged ? (
                        <p className="text-primary-300">
                            Configuration changed. Save the policy again to enable
                            automatic deployment.
                        </p>
                    ) : (
                        policy.mode !== "manual" && (
                            <p className="text-primary-400">
                                Daily at {policy.window.start} · {policy.window.minutes}{" "}
                                minutes · {policy.timeZone}
                            </p>
                        )
                    )}
                    {policy.paused && (
                        <p className="wrap-break-word text-primary-300">
                            {policy.reason}
                            {policy.until !== null && (
                                <> · Resumes {formatDateTime(policy.until)}</>
                            )}
                        </p>
                    )}
                </div>
                <div className="flex w-full flex-col gap-2 @min-[40rem]/deployment:w-auto @min-[40rem]/deployment:flex-row">
                    <Button variant="secondary" onClick={() => setDialog("edit")}>
                        Edit policy
                    </Button>
                    {policy.version > 0 &&
                        (policy.paused ? (
                            <Button
                                variant="secondary"
                                disabled={resume.isPending}
                                onClick={() => void resume.mutateAsync().catch(() => {})}
                            >
                                Resume deployment
                            </Button>
                        ) : (
                            policy.mode !== "manual" && (
                                <Button
                                    variant="secondary"
                                    onClick={() => setDialog("pause")}
                                >
                                    Pause deployment
                                </Button>
                            )
                        ))}
                </div>
            </div>
            {resume.isError && <ErrorNotice error={resume.error} />}
            {dialog === "edit" && (
                <DeploymentPolicyDialog
                    policy={policy}
                    onClose={() => setDialog(undefined)}
                />
            )}
            {dialog === "pause" && (
                <DeploymentPauseDialog
                    policy={policy}
                    onClose={() => setDialog(undefined)}
                />
            )}
        </div>
    );
}
