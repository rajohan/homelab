import type { MiraReport } from "@homelab/contracts/mira";
import {
    Badge,
    Button,
    buttonStyles,
    SectionHeader,
    Card,
    DatePicker,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    PageHeader,
    SearchInput,
    Select,
    Switch,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { FileText, ArrowUpRight } from "lucide-react";
import { useState } from "react";
import * as v from "valibot";

import { api } from "../api/client";
import { ReportDetail } from "../features/mira/ReportDetail";

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
                title="Reports"
                description="Briefs, summaries, findings and verified work from Mira."
            />
            <Card className="space-y-4">
                <SearchInput
                    label="Search reports"
                    placeholder="Search report content…"
                    value={search}
                    onChange={setSearch}
                    maxLength={160}
                />
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
                <div className="grid gap-3 sm:grid-cols-2">
                    <Switch
                        label="Archived reports"
                        checked={archived}
                        onChange={setArchived}
                    />
                    <Switch label="Filter by date" checked={dated} onChange={setDated} />
                </div>
                {dated && (
                    <div className="grid gap-3 sm:grid-cols-2">
                        <DatePicker label="From" value={from} onChange={setFrom} />
                        <DatePicker label="Until" value={until} onChange={setUntil} />
                    </div>
                )}
            </Card>
            {query.isPending && (
                <Card>
                    <LoadingState label="Loading reports…" />
                </Card>
            )}
            {query.error && (
                <Card>
                    <ErrorNotice error={query.error} />
                </Card>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
                {rows.map((report) => (
                    <Card key={report.id} className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                            <Badge>{report.kind}</Badge>
                            <Badge>{report.source}</Badge>
                            {report.outcome && (
                                <Badge>{report.outcome.replaceAll("_", " ")}</Badge>
                            )}
                        </div>
                        <SectionHeader title={report.title} icon={FileText} />
                        <p className="line-clamp-3 text-sm leading-6 wrap-anywhere text-primary-300">
                            {report.markdown.slice(0, 360)}
                        </p>
                        <div className="flex flex-col gap-3 border-t border-primary-700 pt-3 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-xs text-primary-400">
                                {formatDateTime(report.createdAt)}
                            </p>
                            <Link
                                to="/reports/$reportId"
                                params={{ reportId: report.id }}
                                className={buttonStyles({ variant: "secondary" })}
                            >
                                <ArrowUpRight size={16} aria-hidden="true" />
                                Open report
                            </Link>
                        </div>
                    </Card>
                ))}
            </div>
            {!query.isPending && rows.length === 0 && (
                <Card>
                    <p className="text-sm text-primary-400">
                        No reports match these filters.
                    </p>
                </Card>
            )}
            {query.hasNextPage && (
                <Button
                    fullWidth
                    variant="secondary"
                    busy={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                >
                    Load more reports
                </Button>
            )}
            {reportId && (
                <ReportDetail
                    id={reportId}
                    onClose={() => void navigate({ to: "/reports" })}
                />
            )}
        </div>
    );
}
