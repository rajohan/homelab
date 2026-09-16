import { cn } from "../../lib/classNames";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variants: Record<ButtonVariant, string> = {
    primary: "bg-accent-700 text-white hover:bg-accent-800 active:bg-accent-900",
    secondary:
        "bg-primary-700 text-primary-50 hover:bg-primary-600 active:bg-primary-800",
    ghost: "bg-transparent text-primary-300 hover:bg-primary-700 hover:text-primary-50 active:bg-primary-600",
    danger: "bg-red-700 text-white hover:bg-red-600 active:bg-red-800",
};
const sizes: Record<ButtonSize, string> = {
    sm: "min-h-11 px-3 py-2 text-sm sm:min-h-9",
    md: "min-h-11 px-4 py-2.5 text-sm sm:min-h-10",
    lg: "min-h-12 px-5 py-3 text-base",
};

/**
 * Compose shared button variants and merge caller-provided Tailwind classes.
 * @returns The merged classes for the requested button appearance.
 */
export function buttonStyles({
    variant = "primary",
    size = "md",
    fullWidth = false,
    className,
}: {
    readonly variant?: ButtonVariant;
    readonly size?: ButtonSize;
    readonly fullWidth?: boolean;
    readonly className?: string | undefined;
} = {}): string {
    return cn(
        "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-300 focus-visible:ring-offset-2 focus-visible:ring-offset-primary-900 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed motion-reduce:transition-none",
        variants[variant],
        sizes[size],
        fullWidth && "w-full",
        className
    );
}
