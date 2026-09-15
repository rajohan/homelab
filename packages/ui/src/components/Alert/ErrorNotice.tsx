export function ErrorNotice({ error }: { error: unknown }) {
    return (
        <p
            role="alert"
            className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-300"
        >
            {error instanceof Error ? error.message : "The request failed."}
        </p>
    );
}
