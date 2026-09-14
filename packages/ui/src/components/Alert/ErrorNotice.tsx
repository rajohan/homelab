export function ErrorNotice({ error }: { error: unknown }) {
    return (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
            {error instanceof Error ? error.message : "The request failed."}
        </p>
    );
}
