import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { EllipsisVertical, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/classNames";
import { buttonStyles } from "../Button/buttonStyles";

export interface DropdownMenuAction {
    readonly id: string;
    readonly label: string;
    readonly icon?: LucideIcon;
    readonly disabled?: boolean;
    readonly danger?: boolean;
    readonly onSelect: () => void;
}

/**
 * Present related actions in an anchored, keyboard-accessible menu.
 * @returns A labelled trigger and compact action list that stays inside the viewport.
 */
export function DropdownMenu({
    label,
    actions,
    disabled = false,
    triggerText,
}: {
    readonly label: string;
    readonly actions: readonly DropdownMenuAction[];
    readonly triggerText?: string | undefined;
    readonly disabled?: boolean;
}) {
    return (
        <Menu as="div" className="relative inline-flex">
            <MenuButton
                type="button"
                disabled={disabled}
                aria-label={label}
                title={label}
                className={buttonStyles({
                    variant: "ghost",
                    size: "sm",
                    className: triggerText
                        ? "border border-primary-700"
                        : "size-11 shrink-0 p-0",
                })}
            >
                <EllipsisVertical aria-hidden="true" size={triggerText ? 16 : 20} />
                {triggerText}
            </MenuButton>
            <MenuItems
                modal={false}
                anchor={{ to: "bottom end", gap: 4, padding: 8 }}
                className="z-60 max-h-80 w-max max-w-[min(22rem,calc(100vw-1rem))] min-w-28 overflow-y-auto overscroll-contain rounded-lg border border-primary-600 bg-primary-900 p-1 shadow-xl shadow-black/35 outline-none"
            >
                {actions.map((action) => {
                    const Icon = action.icon;
                    return (
                        <MenuItem
                            as="button"
                            type="button"
                            key={action.id}
                            disabled={action.disabled ?? false}
                            onClick={action.onSelect}
                            className={buttonStyles({
                                variant: "ghost",
                                size: "sm",
                                className: cn(
                                    "flex w-full justify-start rounded-md text-left font-medium whitespace-normal data-focus:bg-primary-700 data-focus:text-primary-50",
                                    action.danger &&
                                        "text-red-300 data-focus:bg-red-950/50 data-focus:text-red-100"
                                ),
                            })}
                        >
                            {Icon && (
                                <Icon size={16} className="shrink-0" aria-hidden="true" />
                            )}
                            {action.label}
                        </MenuItem>
                    );
                })}
            </MenuItems>
        </Menu>
    );
}
