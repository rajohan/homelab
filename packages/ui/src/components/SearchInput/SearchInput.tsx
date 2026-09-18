import { Search, X } from "lucide-react";
import { useRef } from "react";

import { cn } from "../../lib/classNames";
import { IconButton } from "../Button/IconButton";
import { Input } from "../Input/Input";

interface SearchInputProps {
    readonly className?: string;
    readonly clearLabel?: string;
    readonly disabled?: boolean;
    readonly label: string;
    readonly maxLength?: number;
    readonly onChange: (value: string) => void;
    readonly placeholder?: string;
    readonly value: string;
}

/**
 * Render a controlled search field with an explicit keyboard-accessible clear action.
 * @returns A shared search control that restores input focus after clearing.
 */
export function SearchInput({
    className,
    clearLabel = "Clear search",
    disabled,
    label,
    maxLength,
    onChange,
    placeholder,
    value,
}: SearchInputProps) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <div className={cn("relative min-w-0", className)}>
            <Search
                aria-hidden="true"
                size={18}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-primary-400"
            />
            <Input
                ref={input}
                aria-label={label}
                className="pr-12 pl-10 [&::-webkit-search-cancel-button]:appearance-none"
                disabled={disabled}
                maxLength={maxLength}
                onChange={(event) => onChange(event.currentTarget.value)}
                placeholder={placeholder}
                type="search"
                value={value}
            />
            {value.length > 0 && (
                <IconButton
                    className="absolute top-1/2 right-0.5 -translate-y-1/2 text-primary-400 hover:bg-transparent hover:text-primary-50 active:bg-transparent"
                    disabled={disabled}
                    icon={X}
                    label={clearLabel}
                    onClick={() => {
                        onChange("");
                        input.current?.focus();
                    }}
                />
            )}
        </div>
    );
}
