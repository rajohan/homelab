const codeTools: Readonly<Record<string, string>> = {
    mira_code_executions: "Code activity",
    mira_code_result: "Code result",
    mira_code_run: "Run code",
    mira_code_check: "Check code",
    mira_code_edit: "Edit code",
    mira_code_read_sources: "Read source",
};

/**
 * Name shared code tools without implying which execution target they use.
 * @param tool - Durable tool key, retained unchanged in receipts and approvals.
 * @returns A display label independent of Main or Daytona selection.
 */
export function toolLabel(tool: string): string {
    return codeTools[tool] ?? tool.replace(/^mira_/, "").replaceAll("_", " ");
}
