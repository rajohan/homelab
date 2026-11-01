import type {
    MiraBrowserTabs,
    miraBrowserTabCommandSchema,
} from "@homelab/contracts/miraBrowser";
import { Button } from "@homelab/ui";
import { X } from "lucide-react";
import type * as v from "valibot";

/**
 * Show server-owned tabs using the same controls on the web and Windows.
 * @returns A horizontally scrollable tab list; only the current human controller can change tabs.
 */
export function BrowserTabBar({
    tabs,
    disabled,
    onCommand,
}: {
    readonly tabs: MiraBrowserTabs;
    readonly disabled: boolean;
    readonly onCommand: (
        input: v.InferOutput<typeof miraBrowserTabCommandSchema>
    ) => void;
}) {
    return (
        <nav
            aria-label="Browser tabs"
            className="overflow-x-auto border-b border-primary-700 p-2"
        >
            <ul className="flex w-max min-w-full gap-2">
                {tabs.items.map((tab) => (
                    <li key={tab.id} className="flex min-w-0 items-center gap-1">
                        <Button
                            variant={tab.id === tabs.selectedId ? "primary" : "secondary"}
                            aria-current={tab.id === tabs.selectedId ? "page" : undefined}
                            disabled={disabled}
                            onClick={() => {
                                if (tab.id !== tabs.selectedId)
                                    onCommand({ action: "select", tabId: tab.id });
                            }}
                            title={tab.url}
                        >
                            <span className="max-w-44 truncate">
                                {tab.title || tab.url}
                            </span>
                        </Button>
                        <Button
                            variant="secondary"
                            aria-label={`Close tab: ${tab.title || tab.url}`}
                            disabled={disabled || tabs.items.length === 1}
                            onClick={() => onCommand({ action: "close", tabId: tab.id })}
                        >
                            <X size={14} aria-hidden="true" />
                        </Button>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
