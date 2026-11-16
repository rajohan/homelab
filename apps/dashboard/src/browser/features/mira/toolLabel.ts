const codeTools: Readonly<Record<string, string>> = {
    mira_daytona_jobs: "Code jobs",
    mira_daytona_result: "Code job result",
    mira_daytona_draft: "Prepare code job",
    mira_daytona_check_draft: "Prepare code checks",
    mira_daytona_edit_draft: "Prepare code edits",
    mira_daytona_source_draft: "Prepare source inspection",
};

/**
 * Name shared code tools without implying which execution target they use.
 * @param tool - Durable tool key, retained unchanged in receipts and approvals.
 * @returns A display label independent of Main or Daytona selection.
 */
export function toolLabel(tool: string): string {
    return codeTools[tool] ?? tool.replace(/^mira_/, "").replaceAll("_", " ");
}
