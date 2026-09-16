import { ErrorState } from "@homelab/ui";
import type { ErrorComponentProps } from "@tanstack/react-router";

/**
 * Show a safe route error and retry through the router's reset callback.
 * @returns The component's rendered content for its current state.
 */
export function RouteError({ reset }: ErrorComponentProps) {
    return <ErrorState onRetry={reset} />;
}
