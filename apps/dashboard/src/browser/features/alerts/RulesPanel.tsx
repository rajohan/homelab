import {
    DetailEntry,
    DetailFacts,
    ErrorNotice,
    FilterBar,
    formatDateTime,
    LoadingState,
    queryRefresh,
    ScrollList,
    SearchInput,
    SectionPanel,
    Select,
    SortControl,
    useInventorySort,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { ObservationBadge } from "../operations/ObservationBadge";
import { RuleStatus } from "./RuleStatus";

/**
 * List all loaded alerting rules independently of active incident delivery and personal receipts.
 * @returns Searchable rules with live state, grouping and evaluation timestamps.
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
    const { ordered, control } = useInventorySort(rows, [
        { label: "Rule", value: (row) => row.name },
        { label: "Group", value: (row) => row.group },
        {
            label: "Status",
            value: (row) => (stale ? null : `${row.health} ${row.state}`),
        },
        { label: "Evaluation interval", value: (row) => row.intervalSeconds },
        { label: "Last evaluated", value: (row) => row.lastEvaluationAt },
    ]);
    return (
        <SectionPanel
            title="Monitoring rules"
            description="Alerting rules, evaluation health and current status."
            icon={Activity}
            badge={
                data && (
                    <ObservationBadge
                        configured={data?.configured ?? true}
                        available={Boolean(data?.inventory)}
                        stale={stale}
                    />
                )
            }
            actions={<SortControl label="monitoring rules" {...control} />}
        >
            {query.isPending && <LoadingState label="Loading monitoring rules…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            <FilterBar
                search={
                    <SearchInput
                        label="Search monitoring rules"
                        placeholder="Find a rule or group…"
                        clearLabel="Clear rule search"
                        value={search}
                        onChange={setSearch}
                    />
                }
            >
                <Select
                    label="Rule status"
                    value={filter}
                    onChange={setFilter}
                    options={[
                        { value: "all", label: "All rules" },
                        { value: "attention", label: "Needs attention" },
                    ]}
                />
            </FilterBar>
            {rows.length > 0 ? (
                <ScrollList
                    label="Monitoring rule evaluations"
                    rows={ordered}
                    getKey={(row) => row.id}
                    className="@container/entries"
                    framed
                    itemClassName="p-3 sm:px-4"
                    renderItem={(row) => (
                        <DetailEntry
                            wideName
                            name={row.name}
                            description={row.group}
                            accessory={<RuleStatus rule={row} stale={stale} />}
                        >
                            <DetailFacts
                                items={[
                                    {
                                        label: "Evaluates every",
                                        value: `${row.intervalSeconds} seconds`,
                                    },
                                    {
                                        label: "Last evaluated",
                                        value: row.lastEvaluationAt
                                            ? formatDateTime(row.lastEvaluationAt)
                                            : "Not reported",
                                    },
                                ]}
                            />
                        </DetailEntry>
                    )}
                />
            ) : (
                <p className="rounded-lg border border-primary-700 bg-surface-empty p-4 text-sm text-primary-400">
                    {search || filter !== "all"
                        ? "No matching monitoring rules."
                        : "No monitoring rule inventory is available."}
                </p>
            )}
        </SectionPanel>
    );
}
