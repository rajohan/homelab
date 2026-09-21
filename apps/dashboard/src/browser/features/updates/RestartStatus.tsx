import { Badge, formatDateTime } from "@homelab/ui";

/**
 * Keep a host's restart requirement visible independently of notification receipts.
 * @returns A warning for a required restart, or explicit current/unknown status.
 */
export function RestartStatus({
    observation,
    unavailable,
}: {
    readonly observation:
        | {
              readonly required: boolean | null;
              readonly observedAt: string;
              readonly stale: boolean;
          }
        | null
        | undefined;
    readonly unavailable: boolean;
}) {
    if (unavailable || !observation || observation.stale || observation.required === null)
        return <Badge tone="neutral">Unknown</Badge>;
    return (
        <span title={`Checked ${formatDateTime(observation.observedAt)}`}>
            {observation.required ? (
                <Badge tone="warning">Restart required</Badge>
            ) : (
                <span className="text-primary-400">No restart reported</span>
            )}
        </span>
    );
}
