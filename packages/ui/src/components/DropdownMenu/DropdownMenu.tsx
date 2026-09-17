import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { EllipsisVertical, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/classNames";
import { Button } from "../Button/Button";
import { IconButton } from "../Button/IconButton";

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
}: {
    readonly label: string;
    readonly actions: readonly DropdownMenuAction[];
    readonly disabled?: boolean;
}) {
    return (
        <Menu as="div" className="relative inline-flex">
            <MenuButton
                as={IconButton}
                icon={EllipsisVertical}
                label={label}
                disabled={disabled}
            />
            <MenuItems
                anchor={{ to: "bottom end", gap: 4, padding: 8 }}
                className="z-60 max-h-80 w-64 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg border border-primary-600 bg-primary-900 p-1 shadow-xl shadow-black/35 outline-none"
            >
                {actions.map((action) => {
                    const Icon = action.icon;
                    return (
                        <MenuItem key={action.id} disabled={action.disabled ?? false}>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={action.disabled}
                                onClick={action.onSelect}
                                className={cn(
                                    "w-full justify-start rounded-md font-medium data-focus:bg-primary-700 data-focus:text-primary-50",
                                    action.danger &&
                                        "text-red-300 data-focus:bg-red-950/50 data-focus:text-red-100"
                                )}
                            >
                                {Icon && <Icon size={16} aria-hidden="true" />}
                                {action.label}
                            </Button>
                        </MenuItem>
                    );
                })}
            </MenuItems>
        </Menu>
    );
}
