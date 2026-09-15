import { ErrorState } from "@homelab/ui";
import type { ErrorComponentProps } from "@tanstack/react-router";

export function RouteError({ reset }: ErrorComponentProps) {
    return <ErrorState onRetry={reset} />;
}
