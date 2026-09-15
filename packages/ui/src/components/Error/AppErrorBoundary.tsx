import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

import { AppErrorFallback } from "./AppErrorFallback";

/**
 * Contain render failures and replace the application tree with a safe retry screen.
 * @returns The component's rendered content for its current state.
 */
export function AppErrorBoundary({ children }: { readonly children: ReactNode }) {
    return <ErrorBoundary FallbackComponent={AppErrorFallback}>{children}</ErrorBoundary>;
}
