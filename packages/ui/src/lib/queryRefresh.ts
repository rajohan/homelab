const intervals = { fast: 5000, normal: 15_000, slow: 30_000, history: 60_000 } as const;

/**
 * Share foreground polling and immediate resume behavior across live query views.
 * @param cadence - The freshness budget appropriate to the source and cost of this query.
 * @returns TanStack Query options; unmounted or hidden views do not poll.
 */
export function queryRefresh(cadence: keyof typeof intervals) {
    return {
        refetchInterval: intervals[cadence],
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: "always" as const,
        refetchOnReconnect: "always" as const,
    };
}
