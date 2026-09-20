import { PageHeader } from "@homelab/ui";

import { UpdatesPanel } from "../features/updates/UpdatesPanel";

/**
 * Keep update observations separate from application lifecycle control.
 * @returns The read-only software update page.
 */
export function Updates() {
    return (
        <>
            <PageHeader
                title="Updates"
                description="Installed software, available versions and check coverage."
            />
            <UpdatesPanel />
        </>
    );
}
