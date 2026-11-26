import type {
    MiraBrowserTabs,
    miraBrowserWorkspaceCommandSchema,
} from "@homelab/contracts/miraBrowser";
import { ghostButtonHover, IconButton } from "@homelab/ui";
import { ArrowLeft, ArrowRight, Globe2, Plus, RotateCw, X } from "lucide-react";
import { type ReactNode, type RefObject, useRef } from "react";
import type * as v from "valibot";

import { BrowserAddressField } from "./BrowserAddressField";

/** Show the host's actual tab list, history controls and address inside the chat workspace.
 * @returns Browser chrome scoped to the selected tab and the current control grant.
 */
export function BrowserNavigation({
    tabs,
    control,
    busy,
    onCommand,
    windowControls,
    menu,
    field,
    onTabShown,
}: {
    readonly onTabShown: (id: string) => void;
    readonly windowControls: ReactNode;
    readonly menu: ReactNode;
    readonly field: RefObject<HTMLInputElement | null>;
    readonly tabs: MiraBrowserTabs;
    readonly control: boolean;
    readonly busy: boolean;
    readonly onCommand: (
        input: v.InferOutput<typeof miraBrowserWorkspaceCommandSchema>
    ) => void;
}) {
    const strip = useRef<HTMLDivElement>(null);
    const active = tabs.items.find((item) => item.id === tabs.selectedId);
    const disabled = !control || busy;
    const shown = useRef("");
    const showSelected = (button: HTMLButtonElement | null) => {
        if (!button || !strip.current || shown.current === tabs.selectedId) return;
        shown.current = tabs.selectedId;
        const viewport = strip.current.getBoundingClientRect();
        const item = (button.parentElement ?? button).getBoundingClientRect();
        if (item.left < viewport.left)
            strip.current.scrollLeft += item.left - viewport.left;
        else if (item.right > viewport.right)
            strip.current.scrollLeft += item.right - viewport.right;
        onTabShown(tabs.selectedId);
    };
    if (!active) return null;
    return (
        <div className="shrink-0 border-b border-primary-700 bg-surface-heading">
            <div className="flex min-w-0 items-center gap-0.5 px-1.5 pt-1">
                <div
                    ref={strip}
                    role="tablist"
                    aria-label="Browser tabs"
                    className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto overscroll-x-contain"
                >
                    {tabs.items.map((tab) => {
                        const selected = tab.id === active.id;
                        const title =
                            tab.title ||
                            (tab.url && URL.canParse(tab.url)
                                ? new URL(tab.url).hostname
                                : "New tab");
                        return (
                            <div
                                key={tab.id}
                                role="presentation"
                                className={`flex min-w-0 shrink-0 items-center rounded-t-lg border border-b-0 ${selected ? "border-primary-700 bg-primary-800 text-primary-50" : `border-transparent text-primary-400 transition-colors motion-reduce:transition-none ${ghostButtonHover}`}`}
                            >
                                <button
                                    type="button"
                                    ref={selected ? showSelected : undefined}
                                    role="tab"
                                    aria-selected={selected}
                                    title={title}
                                    aria-disabled={disabled}
                                    tabIndex={selected ? 0 : -1}
                                    className="flex h-10 max-w-40 min-w-0 items-center gap-2 rounded-t-lg px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-300 aria-[disabled=false]:cursor-pointer"
                                    onClick={() => {
                                        if (!disabled && !selected)
                                            onCommand({
                                                action: "select",
                                                tabId: tab.id,
                                            });
                                    }}
                                    onKeyDown={(event) => {
                                        const items = [
                                            ...(strip.current?.querySelectorAll<HTMLButtonElement>(
                                                '[role="tab"]'
                                            ) ?? []),
                                        ];
                                        const i = items.indexOf(event.currentTarget);
                                        let next: number;
                                        if (event.key === "ArrowLeft")
                                            next = (i + items.length - 1) % items.length;
                                        else if (event.key === "ArrowRight")
                                            next = (i + 1) % items.length;
                                        else if (event.key === "Home") next = 0;
                                        else if (event.key === "End")
                                            next = items.length - 1;
                                        else return;
                                        event.preventDefault();
                                        items[next]?.focus();
                                    }}
                                >
                                    <Globe2
                                        size={14}
                                        aria-hidden="true"
                                        className="shrink-0"
                                    />
                                    <span className="truncate">{title}</span>
                                </button>
                                {selected && control && tabs.items.length > 1 && (
                                    <IconButton
                                        size="sm"
                                        icon={X}
                                        label={`Close tab: ${title}`}
                                        disabled={busy}
                                        className="mr-0.5 size-8 min-h-8 [&_svg]:size-3.5"
                                        onClick={() =>
                                            onCommand({ action: "close", tabId: tab.id })
                                        }
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>
                <IconButton
                    icon={Plus}
                    label="New browser tab"
                    size="sm"
                    disabled={disabled || tabs.items.length >= 8}
                    className="size-9 min-h-9 [&_svg]:size-4"
                    onClick={() => {
                        onCommand({ action: "open" });
                    }}
                />
                <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
                    {windowControls}
                </div>
            </div>
            <div className="flex min-w-0 items-center gap-0.5 border-t border-primary-700 bg-primary-800 p-1.5">
                <IconButton
                    icon={ArrowLeft}
                    label="Go back"
                    size="sm"
                    className="size-9 min-h-9 [&_svg]:size-4"
                    disabled={disabled || !tabs.canGoBack}
                    onClick={() => onCommand({ action: "back", tabId: active.id })}
                />
                <IconButton
                    icon={ArrowRight}
                    label="Go forward"
                    size="sm"
                    className="size-9 min-h-9 [&_svg]:size-4"
                    disabled={disabled || !tabs.canGoForward}
                    onClick={() => onCommand({ action: "forward", tabId: active.id })}
                />
                <IconButton
                    icon={RotateCw}
                    label="Reload page"
                    size="sm"
                    className="size-9 min-h-9 [&_svg]:size-4"
                    disabled={disabled || !active.url}
                    onClick={() => onCommand({ action: "reload", tabId: active.id })}
                />
                <BrowserAddressField
                    key={active.id}
                    field={field}
                    url={active.url}
                    readOnly={!control}
                    blocked={busy}
                    onNavigate={(url) =>
                        onCommand({ action: "navigate", tabId: active.id, url })
                    }
                />
                {menu}
            </div>
            {tabs.warning && (
                <output className="block border-t border-primary-700 px-3 py-2 text-xs text-amber-300">
                    {tabs.warning}
                </output>
            )}
        </div>
    );
}
