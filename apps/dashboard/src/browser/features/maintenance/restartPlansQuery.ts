import { queryRefresh } from "@homelab/ui";
import { queryOptions } from "@tanstack/react-query";

import { api } from "../../api/client";

/** Shared fleet observations for the Overview and Restarts pages. */
export const restartPlansQuery = queryOptions({
    queryKey: ["operations", "maintenance"],
    queryFn: ({ signal }) => api.maintenance.plans.query(undefined, { signal }),
    ...queryRefresh("fast"),
    retry: false,
});
