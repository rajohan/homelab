import { queryRefresh } from "@homelab/ui";
import { queryOptions } from "@tanstack/react-query";

import { api } from "../../api/client";

export const backupCatalogQuery = queryOptions({
    queryKey: ["operations", "backup-catalog"],
    queryFn: ({ signal }) => api.backups.catalog.query(undefined, { signal }),
    ...queryRefresh("normal"),
    retry: false,
});
