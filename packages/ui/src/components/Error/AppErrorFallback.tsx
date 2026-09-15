import type { FallbackProps } from "react-error-boundary";

import { ErrorState } from "./ErrorState";

/**
 * Offer a render-retry action without displaying internal exception details.
 * @returns The component's rendered content for its current state.
 */
export function AppErrorFallback({ resetErrorBoundary }: FallbackProps) {
    return (
        <main className="flex min-h-dvh items-center justify-center p-4">
            <ErrorState onRetry={resetErrorBoundary} />
        </main>
    );
}
