import type { MiraReport } from "@homelab/contracts/mira";
import {
    Badge,
    Button,
    DatePicker,
    EmptyState,
    EventTimeline,
    FilterBar,
    InfiniteScrollTrigger,
    LoadingState,
    PageHeader,
    SearchInput,
    SectionPanel,
    Select,
    Switch,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowUpRight, FileText, History } from "lucide-react";
import { useState } from "react";
import * as v from "valibot";

import { api } from "../api/client";
import { ReportDetail } from "../features/mira/ReportDetail";
import { miraStatusTone } from "../features/mira/statusTone";

/**
 * Browse immutable report snapshots with source, outcome, type and date filters.
 * @returns Searchable report history with stable detail links and bounded pagination.
 */
export function Reports() {
    const parsed = v.safeParse(
        v.object({ reportId: v.optional(v.pipe(v.string(), v.uuid())) }),
        useParams({ strict: false })
    );
    const reportId = parsed.success ? parsed.output.reportId : undefined;
    const navigate = useNavigate();
    const [search, setSearch] = useState("");
    const [kind, setKind] = useState<MiraReport["kind"] | "all">("all");
    const [source, setSource] = useState<MiraReport["source"] | "all">("all");
    const [outcome, setOutcome] = useState<NonNullable<MiraReport["outcome"]> | "all">(
        "all"
    );
    const [archived, setArchived] = useState(false);
    const [dated, setDated] = useState(false);
    const [from, setFrom] = useState(() => new Date(Date.now() - 7 * 86_400_000));
    const [until, setUntil] = useState(() => new Date());
    const activeFilters = [
        kind !== "all",
        source !== "all",
        outcome !== "all",
        archived,
        dated,
    ].filter(Boolean).length;
    function clearFilters() {
        setSearch("");
        setKind("all");
        setSource("all");
        setOutcome("all");
        setArchived(false);
        setDated(false);
    }
    const filter = {
        search,
        archived,
        ...(kind === "all" ? {} : { kind }),
        ...(source === "all" ? {} : { source }),
        ...(outcome === "all" ? {} : { outcome }),
        ...(dated
            ? {
                  from: new Date(
                      from.getFullYear(),
                      from.getMonth(),
                      from.getDate()
                  ).toISOString(),
                  until: new Date(
                      until.getFullYear(),
                      until.getMonth(),
                      until.getDate() + 1
                  ).toISOString(),
              }
            : {}),
    };
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "reports", filter],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }) =>
            api.mira.reports.list.query(
                { ...filter, ...(pageParam ? { before: pageParam } : {}) },
                { signal }
            ),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    return (
        <div className="space-y-4">
            <PageHeader
                icon={FileText}
                title="Reports"
                description="Briefs, summaries, findings and verified work from Mira."
            />
            <SectionPanel icon={History} title="Report history">
                <FilterBar
                    activeFilters={activeFilters}
                    search={
                        <SearchInput
                            label="Search reports"
                            placeholder="Search report content…"
                            value={search}
                            onChange={setSearch}
                            maxLength={160}
                        />
                    }
                >
                    <div className="grid gap-3 sm:grid-cols-3">
                        <Select
                            label="Report type"
                            value={kind}
                            onChange={setKind}
                            options={[
                                { value: "all", label: "All types" },
                                { value: "brief", label: "Brief" },
                                { value: "summary", label: "Summary" },
                                { value: "improvement", label: "Improvement" },
                                { value: "task", label: "Task" },
                                { value: "other", label: "Other" },
                            ]}
                        />
                        <Select
                            label="Report source"
                            value={source}
                            onChange={setSource}
                            options={[
                                { value: "all", label: "All sources" },
                                { value: "manual", label: "Written manually" },
                                { value: "chat", label: "Conversation" },
                                { value: "automation", label: "Automation" },
                            ]}
                        />
                        <Select
                            label="Execution outcome"
                            value={outcome}
                            onChange={setOutcome}
                            options={[
                                { value: "all", label: "All outcomes" },
                                { value: "completed", label: "Completed" },
                                { value: "running", label: "Running" },
                                { value: "queued", label: "Queued" },
                                { value: "interrupted", label: "Interrupted" },
                                { value: "failed", label: "Failed" },
                                { value: "needs_attention", label: "Needs attention" },
                            ]}
                        />
                    </div>
                    <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:gap-x-8">
                        <Switch
                            className="items-center sm:w-auto"
                            label="Archived reports"
                            checked={archived}
                            onChange={setArchived}
                        />
                        <Switch
                            className="items-center sm:w-auto"
                            label="Filter by date"
                            checked={dated}
                            onChange={setDated}
                        />
                    </div>
                    {dated && (
                        <div className="grid gap-3 sm:grid-cols-2">
                            <DatePicker label="From" value={from} onChange={setFrom} />
                            <DatePicker label="Until" value={until} onChange={setUntil} />
                        </div>
                    )}
                </FilterBar>
                {query.isPending && <LoadingState label="Loading reports…" />}
                {rows.length > 0 && (
                    <EventTimeline
                        presentation="feed"
                        events={rows.map((report) => ({
                            id: report.id,
                            time: report.createdAt,
                            tone: "neutral",
                            title: (
                                <Link
                                    to="/reports/$reportId"
                                    params={{ reportId: report.id }}
                                    className="inline-flex items-baseline gap-2 rounded text-base leading-snug font-semibold tracking-tight wrap-anywhere text-primary-50 hover:text-accent-300"
                                >
                                    {report.title}
                                    <ArrowUpRight
                                        size={15}
                                        className="shrink-0 self-center text-accent-300"
                                        aria-hidden="true"
                                    />
                                </Link>
                            ),
                            detail: (
                                <>
                                    {" "}
                                    <p className="mt-1 line-clamp-3 max-w-prose text-sm leading-6 wrap-anywhere text-primary-300">
                                        {report.markdown.slice(0, 360)}
                                    </p>
                                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-primary-400">
                                        <span className="capitalize">{report.kind}</span>
                                        <span aria-hidden="true">·</span>
                                        <span className="capitalize">
                                            {report.source}
                                        </span>
                                        {report.outcome && (
                                            <Badge tone={miraStatusTone(report.outcome)}>
                                                {report.outcome.replaceAll("_", " ")}
                                            </Badge>
                                        )}
                                    </div>
                                </>
                            ),
                        }))}
                    />
                )}
                {!query.isPending && !query.isError && rows.length === 0 && (
                    <EmptyState
                        icon={FileText}
                        title={
                            search || activeFilters
                                ? "No matching reports"
                                : "No reports yet"
                        }
                        description={
                            search || activeFilters
                                ? "Try another search or clear your filters."
                                : "Reports published by Mira appear here."
                        }
                        action={
                            (search || activeFilters > 0) && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={clearFilters}
                                >
                                    Clear filters
                                </Button>
                            )
                        }
                    />
                )}
                <InfiniteScrollTrigger
                    itemCount={query.data?.pages.length ?? 0}
                    hasMore={query.hasNextPage}
                    loading={query.isFetchingNextPage}
                    refreshing={query.isRefetching}
                    error={query.isError ? query.error : undefined}
                    onLoadMore={() =>
                        void (query.isRefetchError
                            ? query.refetch()
                            : query.fetchNextPage())
                    }
                />
            </SectionPanel>
            {reportId && (
                <ReportDetail
                    id={reportId}
                    onClose={() => void navigate({ to: "/reports" })}
                />
            )}
        </div>
    );
}
