import { queryRefresh } from "@homelab/ui";
import { queryOptions } from "@tanstack/react-query";

import { api } from "../../api/client";

export const workerOverviewQuery = queryOptions({
    queryKey: ["operations", "worker"],
    queryFn: ({ signal }) => api.worker.overview.query(undefined, { signal }),
    ...queryRefresh("fast"),
    retry: false,
});
