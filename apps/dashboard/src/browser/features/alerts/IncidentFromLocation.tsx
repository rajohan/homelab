import { ErrorNotice, LoadingState, Modal } from "@homelab/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import * as v from "valibot";

import { api } from "../../api/client";
import { IncidentDetails } from "./IncidentDetails";
import { incidentLocation } from "./incidentLocation";
import { incidentOptions } from "./incidentQueries";

/** Open one incident from a notification or bookmarked occurrence and return to its feed on close.
 * @returns The selected detail dialog, including lookup and missing-record states.
 */
export function IncidentFromLocation() {
    const params = v.parse(incidentLocation, useSearch({ from: "/alerts" }));
    const navigate = useNavigate({ from: "/alerts" });
    const focus = params.notice ?? params.incident;
    const kind = params.notice ? "notification" : "incident";
    const occurrence = useQuery({
        queryKey: ["operations", "alerts", "occurrence", kind, focus],
        enabled: Boolean(focus),
        queryFn: ({ signal }) =>
            api.alerts.occurrence.query({ kind, id: focus ?? "" }, { signal }),
        retry: false,
        refetchInterval: focus ? 15_000 : false,
    });
    const current = useInfiniteQuery({
        ...incidentOptions("current"),
        enabled: Boolean(focus),
    });
    const unavailable =
        current.isError ||
        !current.data?.pages[0]?.capturedAt ||
        current.data.pages.some((page) => !page.configured || page.stale);
    useEffect(() => {
        if (!focus && params.view === "resolved" && !globalThis.location.hash)
            document.querySelector("#resolved")?.scrollIntoView();
    }, [params.view, focus]);
    const close = () => {
        let view = params.view ?? "current";
        if (occurrence.data)
            view = occurrence.data.state === "resolved" ? "resolved" : "current";
        void navigate({
            to: "/alerts",
            search: { view },
            hash: view === "resolved" ? "resolved" : "incidents",
            replace: true,
        });
    };
    return (
        <>
            {" "}
            {focus && occurrence.data && (
                <IncidentDetails
                    incident={occurrence.data}
                    unavailable={unavailable && occurrence.data.state !== "resolved"}
                    onClose={close}
                />
            )}
            {focus && !occurrence.data && (
                <Modal title="Incident details" onClose={close}>
                    {occurrence.isPending && (
                        <LoadingState label="Loading this incident…" />
                    )}
                    {occurrence.isError && <ErrorNotice error={occurrence.error} />}
                    {occurrence.isSuccess && (
                        <p className="text-sm text-primary-300">
                            This occurrence is no longer in the monitoring history.
                        </p>
                    )}
                </Modal>
            )}
        </>
    );
}
