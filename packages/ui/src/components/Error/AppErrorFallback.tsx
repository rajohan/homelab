import type { FallbackProps } from "react-error-boundary";

import { ErrorState } from "./ErrorState";

export function AppErrorFallback({ resetErrorBoundary }: FallbackProps) {
    return (
        <main className="flex min-h-dvh items-center justify-center p-4">
            <ErrorState onRetry={resetErrorBoundary} />
        </main>
    );
}
