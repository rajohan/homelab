import type { TableSort } from "@homelab/contracts/tableSort";

/**
 * Keep a paged table mounted while the server applies a different ordering.
 * @param scope - Resource and filter values identifying the list, excluding its ordering.
 * @param sort - Requested server ordering, or null for the default.
 * @returns Query options that reuse rows only within the same filtered list.
 */
export function sortedListQuery(
    scope: readonly (string | boolean | undefined)[],
    sort: TableSort | null
) {
    return {
        queryKey: [...scope, sort],
        placeholderData: <T>(
            data: T,
            previous: { queryKey: readonly unknown[] } | undefined
        ) =>
            previous?.queryKey.length === scope.length + 1 &&
            scope.every((value, index) => value === previous.queryKey[index])
                ? data
                : undefined,
    };
}
