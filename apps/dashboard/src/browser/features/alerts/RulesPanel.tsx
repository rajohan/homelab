import {
    Card,
    DataTable,
    ErrorNotice,
    LoadingState,
    SearchInput,
    SectionHeader,
    Select,
    formatDateTime,
    queryRefresh,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { ObservationBadge } from "../operations/ObservationBadge";
import { RuleStatus } from "./RuleStatus";

/**
 * List all loaded alerting rules independently of active incident delivery and personal receipts.
 * @returns Searchable, virtualized rules with live state, grouping and evaluation timestamps.
 */
export function RulesPanel() {
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState("all");
    const query = useQuery({
        queryKey: ["operations", "rules"],
        queryFn: ({ signal }) => api.alerts.rules.query(undefined, { signal }),
        ...queryRefresh("normal"),
        retry: false,
    });
    const data = query.data;
    const stale = !data?.configured || query.isError || (data?.stale ?? true);
    const rows = (data?.inventory?.rules ?? []).filter(
        (rule) =>
            `${rule.name} ${rule.group}`.toLowerCase().includes(search.toLowerCase()) &&
            (filter === "all" ||
                stale ||
                rule.health !== "healthy" ||
                rule.state !== "inactive")
    );
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Monitoring rules"
                description="Alerting rules, evaluation health and current status."
                icon={Activity}
                actions={
                    <ObservationBadge
                        configured={data?.configured ?? true}
                        available={Boolean(data?.inventory)}
                        stale={stale}
                    />
                }
            />
            {query.isPending && <LoadingState label="Loading monitoring rules…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
                <SearchInput
                    label="Search monitoring rules"
                    placeholder="Find a rule or group…"
                    clearLabel="Clear rule search"
                    value={search}
                    onChange={setSearch}
                />
                <Select
                    label="Rule status"
                    value={filter}
                    onChange={setFilter}
                    options={[
                        { value: "all", label: "All rules" },
                        { value: "attention", label: "Needs attention" },
                    ]}
                />
            </div>
            {rows.length > 0 ? (
                <DataTable
                    label="Monitoring rules"
                    compact
                    rows={rows}
                    getKey={(row) => row.id}
                    columns={[
                        {
                            id: "name",
                            sortValue: (row) => row.name,
                            label: "Rule",
                            mobile: "title",
                            render: (row) => row.name,
                        },
                        {
                            id: "group",
                            sortValue: (row) => row.group,
                            label: "Group",
                            render: (row) => row.group,
                        },
                        {
                            id: "state",
                            sortValue: (row) =>
                                stale ? null : `${row.health} ${row.state}`,
                            label: "Status",
                            render: (row) => <RuleStatus rule={row} stale={stale} />,
                        },
                        {
                            id: "cadence",
                            sortValue: (row) => row.intervalSeconds,
                            label: "Evaluation interval",
                            render: (row) => `${row.intervalSeconds} seconds`,
                        },
                        {
                            id: "evaluated",
                            sortValue: (row) => row.lastEvaluationAt,
                            label: "Last evaluated",
                            mobile: "wide",
                            render: (row) =>
                                row.lastEvaluationAt
                                    ? formatDateTime(row.lastEvaluationAt)
                                    : "Not reported",
                        },
                    ]}
                />
            ) : (
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    {search || filter !== "all"
                        ? "No matching monitoring rules."
                        : "No monitoring rule inventory is available."}
                </p>
            )}
        </Card>
    );
}
