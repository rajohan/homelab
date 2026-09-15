export function LoadingDots({ label }: { readonly label: string }) {
    const text = label.replace(/(?:…|\.{1,3})$/u, "").trimEnd();
    const lastSpace = text.lastIndexOf(" ");
    return (
        <span aria-hidden="true">
            {lastSpace === -1 ? "" : text.slice(0, lastSpace + 1)}
            <span className="whitespace-nowrap">
                {text.slice(lastSpace + 1)}
                <span className="inline-block min-w-6 text-left">
                    <span>.</span>
                    <span className="inline-block animate-[loading-state-second-dot_1.2s_steps(1,end)_infinite] opacity-0 motion-reduce:animate-none motion-reduce:opacity-100">
                        .
                    </span>
                    <span className="inline-block animate-[loading-state-third-dot_1.2s_steps(1,end)_infinite] opacity-0 motion-reduce:animate-none motion-reduce:opacity-100">
                        .
                    </span>
                </span>
            </span>
        </span>
    );
}
