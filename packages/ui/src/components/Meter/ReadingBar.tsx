/** Draw a measured percentage alongside its visible numeric reading. Missing values have no bar.
 * @returns A decorative track with bounded fill, or nothing for an unavailable reading.
 */
export function ReadingBar({
    percent,
    tone = "neutral",
}: {
    readonly percent: number | null;
    readonly tone?: "neutral" | "warning" | "positive" | "accent";
}) {
    if (percent === null || !Number.isFinite(percent)) return null;
    const fill = {
        neutral: "bg-primary-400",
        warning: "bg-red-400",
        positive: "bg-emerald-400/70",
        accent: "bg-accent-400",
    }[tone];
    return (
        <div
            aria-hidden="true"
            className="h-1.5 overflow-hidden rounded-full bg-primary-700"
        >
            <div
                className={`h-full rounded-full ${fill}`}
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
        </div>
    );
}
