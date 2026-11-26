import type { ReactNode } from "react";

/** Keep history at the leading edge and actions at the trailing edge of the chat pane.
 * @returns The shared header for a new or existing conversation.
 */
export function ChatHeader({
    title,
    historyControl,
    details,
    children,
}: {
    readonly title: string;
    readonly historyControl: ReactNode;
    readonly details?: ReactNode;
    readonly children: ReactNode;
}) {
    return (
        <header className="@container/chat-header shrink-0 border-b border-primary-700">
            <div
                className={`min-h-chat-header grid grid-cols-[auto_minmax(0,1fr)_auto] items-center px-3 py-1 sm:px-4 ${details ? "grid-rows-[auto_auto]" : ""}`}
            >
                <div className="col-start-1 row-start-1 flex @min-[34rem]/chat-header:row-span-full [&>button]:me-1">
                    {historyControl}
                </div>
                <h1
                    title={title}
                    className={`col-start-2 row-start-1 min-w-0 truncate pe-2 text-base font-semibold tracking-tight text-primary-50 @min-[34rem]/chat-header:text-lg ${details ? "@min-[34rem]/chat-header:self-end" : ""}`}
                >
                    {title}
                </h1>
                {details && (
                    <div className="col-span-full row-start-2 flex min-w-0 flex-wrap items-center justify-between gap-x-1 @min-[34rem]/chat-header:col-span-1 @min-[34rem]/chat-header:col-start-2 @min-[34rem]/chat-header:justify-start @min-[34rem]/chat-header:gap-x-3 [&>div]:max-w-full">
                        {details}
                    </div>
                )}
                <div className="col-start-3 row-start-1 flex items-center @min-[34rem]/chat-header:row-span-full">
                    {children}
                </div>
            </div>
        </header>
    );
}
