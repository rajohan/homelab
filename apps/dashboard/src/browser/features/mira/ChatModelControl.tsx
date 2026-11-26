import type { MiraChatSettings, MiraModel } from "@homelab/contracts/mira";
import { Popover } from "@homelab/ui";
import { Brain, ChevronDown, CircleAlert, Cpu, Zap } from "lucide-react";
import type { ReactNode } from "react";

/** Display the current run's frozen model choices or the conversation's next-run choices.
 * @returns A model settings trigger that also works as a read-only summary for archived chats.
 */
export function ChatModelControl({
    model,
    modelId,
    settings,
    resolved,
    active,
    fresh,
    loading,
    archived,
    children,
}: {
    readonly model: MiraModel | undefined;
    readonly modelId: string | null;
    readonly settings: Pick<MiraChatSettings, "effort" | "serviceTier">;
    readonly resolved: boolean;
    readonly active: boolean;
    readonly fresh: boolean;
    readonly loading: boolean;
    readonly archived: boolean;
    readonly children: (controls: { close: () => void }) => ReactNode;
}) {
    const effort = settings.effort ?? (resolved ? null : model?.defaultReasoningEffort);
    const tier = settings.serviceTier ?? (resolved ? null : model?.defaultServiceTier);
    const speed = model?.serviceTiers.find((entry) => entry.id === tier)?.name ?? tier;
    const name =
        model?.displayName ||
        modelId ||
        (loading ? "Loading model…" : "Model unavailable");
    const defaultThinking = model?.supportedReasoningEfforts.length ? "Default" : null;
    const thinking = effort
        ? effort.charAt(0).toUpperCase() + effort.slice(1)
        : defaultThinking;
    const speedLabel = speed || (model?.serviceTiers.length ? "Standard" : null);
    const unavailable =
        !resolved &&
        !loading &&
        (!fresh ||
            !model ||
            (!!effort &&
                !model.supportedReasoningEfforts.some(
                    (entry) => entry.reasoningEffort === effort
                )) ||
            (!!tier && !model.serviceTiers.some((entry) => entry.id === tier)));
    const runScope = resolved ? "Current run" : "Requested for this run";
    const scope = active ? runScope : "Next run";
    const label = [
        scope,
        name,
        thinking && thinking + " thinking",
        speedLabel && speedLabel + " speed",
        unavailable && "Model settings unavailable",
    ]
        .filter(Boolean)
        .join(" · ");
    const summary = (
        <>
            <span className="inline-flex max-w-full min-w-0 items-center gap-1 font-semibold text-primary-100">
                <Cpu size={13} aria-hidden="true" className="shrink-0 text-primary-300" />
                <span className="truncate">{name}</span>
            </span>
            {thinking && (
                <span className="inline-flex max-w-full min-w-0 items-center gap-1 text-primary-300">
                    <Brain size={13} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{thinking}</span>
                </span>
            )}
            {speedLabel && (
                <span className="inline-flex max-w-full min-w-0 items-center gap-1 text-primary-300">
                    <Zap size={13} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{speedLabel}</span>
                </span>
            )}
            {unavailable && (
                <CircleAlert
                    size={13}
                    aria-label="Model settings unavailable"
                    className="shrink-0 text-amber-300"
                />
            )}
            {!archived && (
                <ChevronDown
                    size={13}
                    aria-hidden="true"
                    className="shrink-0 text-primary-400"
                />
            )}
        </>
    );
    return (
        <Popover
            triggerStyle="label"
            layout="feed"
            triggerClassName="min-h-8 max-w-full min-w-0 flex-nowrap justify-start gap-2 px-1.5 py-1 text-xs font-medium disabled:opacity-100 sm:min-h-8 @min-[34rem]/chat-header:-translate-x-1.5"
            trigger={summary}
            disabled={archived}
            label={archived ? label : `Open model settings. ${label}`}
            anchor="bottom start"
            panelClassName="w-[min(24rem,calc(100vw-1rem))]"
        >
            {children}
        </Popover>
    );
}
