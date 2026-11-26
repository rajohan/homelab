const toolNames: Readonly<Record<string, string>> = {
    mira_dashboard_access: "Check dashboard access",
    mira_dashboard_read: "Read dashboard data",
    mira_dashboard_request: "Request dashboard action",
    mira_dashboard_publish_inventory: "Publish host inventory",
    mira_browser_open: "Open browser",
    mira_browser_observe: "Inspect page",
    mira_browser_tabs: "Manage browser tabs",
    mira_computer_wait: "Request computer access",
    mira_code_executions: "Code activity",
    mira_code_result: "Code result",
    mira_code_run: "Run code",
    mira_code_check: "Check code",
    mira_code_edit: "Edit code",
    mira_code_read_sources: "Read source",
    mira_workspace_assign: "Assign project files",
    mira_workspace_read: "Read assigned files",
    mira_workspace_edit: "Edit assigned file",
};

/**
 * Name shared code tools without implying which execution target they use.
 * @param tool - Durable tool key, retained unchanged in receipts and approvals.
 * @returns A display label independent of Main or Daytona selection.
 */
export function toolLabel(tool: string): string {
    return toolNames[tool] ?? tool.replace(/^mira_/, "").replaceAll("_", " ");
}
