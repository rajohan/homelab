import { queryRefresh } from "@homelab/ui";
import { queryOptions } from "@tanstack/react-query";

import { api } from "../../api/client";

export const updateInventoryQuery = queryOptions({
    queryKey: ["operations", "updates"],
    queryFn: ({ signal }) => api.updates.inventory.query(undefined, { signal }),
    ...queryRefresh("normal"),
    retry: false,
});
