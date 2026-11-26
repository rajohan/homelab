import { useNavigate, useParams } from "@tanstack/react-router";
import * as v from "valibot";

import { ReportDetail } from "./ReportDetail";

/** Present the linked report over its mounted history.
 * @returns The detail dialog when the path identifies a valid report.
 */
export function ReportFromLocation() {
    const params = v.safeParse(
        v.object({ reportId: v.pipe(v.string(), v.uuid()) }),
        useParams({ from: "/reports/$reportId" })
    );
    const navigate = useNavigate();
    return params.success ? (
        <ReportDetail
            id={params.output.reportId}
            onClose={() => void navigate({ to: "/reports", resetScroll: false })}
        />
    ) : null;
}
