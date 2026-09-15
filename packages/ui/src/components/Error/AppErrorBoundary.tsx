import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

import { AppErrorFallback } from "./AppErrorFallback";

export function AppErrorBoundary({ children }: { readonly children: ReactNode }) {
    return <ErrorBoundary FallbackComponent={AppErrorFallback}>{children}</ErrorBoundary>;
}
