import { queryRefresh } from "@homelab/ui";
import { queryOptions } from "@tanstack/react-query";

import { api } from "../../api/client";

export const backupInventoryQuery = queryOptions({
    queryKey: ["operations", "backups"],
    queryFn: ({ signal }) => api.backups.inventory.query(undefined, { signal }),
    ...queryRefresh("normal"),
    retry: false,
});
