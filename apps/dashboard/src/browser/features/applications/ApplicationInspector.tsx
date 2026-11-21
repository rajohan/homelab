import { Modal, SectionJumpMenu } from "@homelab/ui";
import { Boxes } from "lucide-react";
import { useId, useRef } from "react";

import { ApplicationMeasurements } from "../infrastructure/ApplicationMeasurements";
import { ResourceStatus } from "../infrastructure/ResourceStatus";
import type { ApplicationEntry } from "./applicationDirectory";
import { ApplicationLogs } from "./ApplicationLogs";
import { ApplicationMetadata } from "./ApplicationMetadata";
import { ApplicationStatus } from "./ApplicationStatus";
import { ContainerActions } from "./ContainerActions";

/**
 * Inspect selected safe metadata and request logs when the log section is reached.
 * @returns A bounded detail dialog preserving the live container identity.
 */
export function ApplicationInspector({
    entry,
    capturedAt,
    cores,
    stale,
    logsAvailable,
    available,
    onClose,
}: {
    readonly entry: ApplicationEntry;
    readonly capturedAt: string | undefined;
    readonly cores: number | null;
    readonly stale: boolean;
    readonly logsAvailable: boolean;
    readonly available: boolean;
    readonly onClose: () => void;
}) {
    const prefix = useId();
    const scrollRef = useRef<HTMLElement>(null);
    const { metric, container } = entry;
    const sections = [
        ...(metric
            ? [
                  { value: prefix + "-usage", label: "Resource usage" },
                  { value: prefix + "-history", label: "Resource history" },
              ]
            : []),
        ...(container
            ? [
                  { value: prefix + "-details", label: "Container details" },
                  { value: prefix + "-ports", label: "Published ports" },
                  { value: prefix + "-mounts", label: "Mounts" },
              ]
            : []),
        ...(container && logsAvailable
            ? [{ value: prefix + "-logs", label: "Application logs" }]
            : []),
    ];
    return (
        <Modal
            title={entry.name}
            titleAccessory={
                metric ? (
                    <ResourceStatus state={stale ? "unknown" : metric.state} />
                ) : (
                    container && (
                        <ApplicationStatus
                            state={container.state}
                            health={container.health}
                            available={available}
                        />
                    )
                )
            }
            description={[entry.host, entry.project].filter(Boolean).join(" · ")}
            onClose={onClose}
            icon={Boxes}
            contentRef={scrollRef}
            navigation={
                <SectionJumpMenu
                    label="Jump to application section"
                    scrollRef={scrollRef}
                    sections={sections}
                />
            }
            size="wide"
        >
            <div className="space-y-4">
                {metric && capturedAt && (
                    <ApplicationMeasurements
                        application={metric}
                        capturedAt={capturedAt}
                        cores={cores}
                        stale={stale}
                        prefix={prefix}
                    />
                )}
                {container && (
                    <ApplicationMetadata
                        application={container}
                        prefix={prefix}
                        status={
                            <ApplicationStatus
                                state={container.state}
                                health={container.health}
                                available={available}
                            />
                        }
                        actions={
                            <ContainerActions
                                container={container}
                                available={available}
                            />
                        }
                    />
                )}
                {container && logsAvailable && (
                    <ApplicationLogs application={container} anchor={prefix + "-logs"} />
                )}
            </div>
        </Modal>
    );
}
