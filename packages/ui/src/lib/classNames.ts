import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combines conditional classes and resolves conflicting Tailwind utilities.
 *
 * @param values - Class strings, arrays and conditional objects to combine.
 * @returns The merged class string, with later conflicting utilities taking precedence.
 */
export function cn(...values: ClassValue[]): string {
    return twMerge(clsx(values));
}
