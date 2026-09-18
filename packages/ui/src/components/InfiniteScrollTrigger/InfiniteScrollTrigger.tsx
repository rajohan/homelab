import { useEffect, useEffectEvent, useRef, type RefObject } from "react";

import { ErrorNotice } from "../Alert/ErrorNotice";
import { Button } from "../Button/Button";
import { LoadingState } from "../Loading/LoadingState";

export interface InfiniteScrollContinuation {
    readonly hasMore: boolean;
    readonly loading: boolean;
    readonly error?: unknown;
    readonly onLoadMore: () => void;
    readonly loadingLabel?: string;
    readonly retryLabel?: string;
}

/**
 * Request the next page near the end of a scroll container, with accessible manual retry.
 * @returns Continuation, loading or retry controls without hiding already loaded content.
 */
export function InfiniteScrollTrigger({
    rootRef,
    itemCount,
    hasMore,
    loading,
    error,
    onLoadMore,
    loadingLabel = "Loading more…",
    retryLabel = "Try again",
}: InfiniteScrollContinuation & {
    readonly rootRef: RefObject<HTMLElement | null>;
    readonly itemCount: number;
}) {
    const sentinel = useRef<HTMLDivElement>(null);
    const load = useEffectEvent(onLoadMore);
    useEffect(() => {
        const Observer =
            sentinel.current?.ownerDocument.defaultView?.IntersectionObserver;
        if (!sentinel.current || !hasMore || loading || error || !Observer) return;
        let requested = false;
        const observer = new Observer(
            (entries) => {
                if (!requested && entries.some((entry) => entry.isIntersecting)) {
                    requested = true;
                    load();
                }
            },
            { root: rootRef.current, rootMargin: "200px 0px" }
        );
        observer.observe(sentinel.current);
        return () => observer.disconnect();
    }, [rootRef, hasMore, loading, error, itemCount]);
    if (!hasMore && !error) return null;
    return (
        <div ref={sentinel} className="space-y-2 p-3">
            {loading && <LoadingState label={loadingLabel} />}
            {!loading && error !== undefined && (
                <>
                    <ErrorNotice error={error} />
                    <Button size="sm" variant="secondary" onClick={onLoadMore}>
                        {retryLabel}
                    </Button>
                </>
            )}
        </div>
    );
}
