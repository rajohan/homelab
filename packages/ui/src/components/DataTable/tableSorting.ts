import type { TableSort } from "@homelab/contracts/tableSort";
export {
    compareTableValues,
    type TableSort,
    type TableSortValue,
} from "@homelab/contracts/tableSort";

/**
 * Cycle one column through ascending, descending and the original order.
 * @param current - Current sort, or null for the original order.
 * @param id - Selected column identifier.
 * @returns The next sort state.
 */
export function nextTableSort(current: TableSort | null, id: string): TableSort | null {
    if (current?.id !== id) return { id, direction: "ascending" };
    return current.direction === "ascending" ? { id, direction: "descending" } : null;
}
