import type { SystemStatus } from "@homelab/contracts";
import { Badge, Button, Card, LoadingState } from "@homelab/ui";

/**
 * Display the dashboard API connection state with an explicit retry action.
 * @returns The component's rendered content for its current state.
 */
export function ConnectionStatus({
    pending,
    failed,
    data,
    onRetry,
}: {
    pending: boolean;
    failed: boolean;
    data?: SystemStatus | undefined;
    onRetry: () => void;
}) {
    const connectionTone = data ? "positive" : "neutral";
    const connectionLabel = data ? "Connected" : "Checking";
    return (
        <Card aria-labelledby="connection-heading">
            <div className="mb-4.5 flex items-start justify-between gap-3">
                <h2
                    className="text-[1.05rem] leading-[1.45] font-[650] tracking-[-0.015em]"
                    id="connection-heading"
                >
                    Application connection
                </h2>
                <Badge tone={failed ? "danger" : connectionTone}>
                    {failed ? "Unavailable" : connectionLabel}
                </Badge>
            </div>
            <div aria-live="polite">
                {failed && (
                    <>
                        <p className="text-[0.925rem] leading-[1.7] text-primary-300">
                            The dashboard API could not be reached. No infrastructure
                            status can be inferred from this check.
                        </p>
                        <Button className="mt-3.75" onClick={onRetry}>
                            Try again
                        </Button>
                    </>
                )}
                {!failed && pending && (
                    <LoadingState label="Checking this application's API…" size="sm" />
                )}
                {!failed && !pending && (
                    <>
                        <p className="text-[0.925rem] leading-[1.7] text-primary-300">
                            The dashboard can reach its own API.
                        </p>
                        <dl className="mt-5 grid gap-2.75 border-t border-primary-700 pt-3.5 text-[0.8rem]">
                            <div className="flex justify-between gap-4">
                                <dt className="text-primary-400">Service</dt>
                                <dd className="font-mono text-primary-100">
                                    {data?.service}
                                </dd>
                            </div>
                            <div className="flex justify-between gap-4">
                                <dt className="text-primary-400">Phase</dt>
                                <dd className="font-mono text-primary-100">
                                    {data?.phase}
                                </dd>
                            </div>
                        </dl>
                    </>
                )}
            </div>
        </Card>
    );
}
