import {
    Button,
    type InfiniteScrollContinuation,
    InfiniteScrollTrigger,
} from "@homelab/ui";
import { ArrowDown } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** Follow live activity while preserving the reader's position when older rows arrive.
 * @returns A bounded activity viewport with shared infinite loading and a return action.
 */
export function ActivityFeed({
    children,
    continuation,
    count,
}: {
    readonly children: ReactNode;
    readonly continuation?: InfiniteScrollContinuation | undefined;
    readonly count: number;
}) {
    const viewport = useRef<HTMLDivElement>(null);
    const body = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    const anchor = useRef<{ height: number; top: number } | null>(null);
    const [jump, setJump] = useState(false);
    useLayoutEffect(() => {
        const node = viewport.current;
        if (!node) return;
        if (following.current) node.scrollTop = node.scrollHeight;
        else if (anchor.current && !continuation?.loading) {
            node.scrollTop =
                anchor.current.top + node.scrollHeight - anchor.current.height;
            anchor.current = null;
        }
    }, [children, continuation?.loading]);
    useLayoutEffect(() => {
        const node = viewport.current;
        if (!node || !body.current) return;
        const observer = new ResizeObserver(() => {
            if (following.current) node.scrollTop = node.scrollHeight;
        });
        observer.observe(node);
        observer.observe(body.current);
        return () => observer.disconnect();
    }, []);
    return (
        <div className="relative border-t border-primary-700">
            <div
                ref={viewport}
                className="max-h-64 overflow-y-auto overscroll-contain [overflow-anchor:none]"
                onScroll={(event) => {
                    const node = event.currentTarget;
                    following.current =
                        node.scrollHeight - node.clientHeight - node.scrollTop < 40;
                    setJump(!following.current);
                }}
            >
                <div ref={body} className="space-y-3 p-3">
                    {continuation && (
                        <InfiniteScrollTrigger
                            {...continuation}
                            rootRef={viewport}
                            itemCount={count}
                            loadingLabel="Loading earlier activity…"
                            onLoadMore={() => {
                                const node = viewport.current;
                                if (node && !following.current)
                                    anchor.current = {
                                        height: node.scrollHeight,
                                        top: node.scrollTop,
                                    };
                                continuation.onLoadMore();
                            }}
                        />
                    )}
                    {children}
                </div>
            </div>
            {jump && (
                <Button
                    variant="secondary"
                    size="sm"
                    className="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap shadow-lg"
                    onClick={() => {
                        following.current = true;
                        anchor.current = null;
                        if (viewport.current)
                            viewport.current.scrollTop = viewport.current.scrollHeight;
                        setJump(false);
                    }}
                >
                    <ArrowDown size={14} aria-hidden="true" />
                    Latest activity
                </Button>
            )}
        </div>
    );
}
