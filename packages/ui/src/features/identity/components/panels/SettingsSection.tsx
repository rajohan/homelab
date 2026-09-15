import type { ComponentProps, ReactNode } from "react";

import { Card, SectionHeader } from "../../../../index";

/**
 * Present a compact account-settings section with consistent headings and action placement.
 * @returns A labelled surface that stacks its actions on narrow screens.
 */
export function SettingsSection({
    id,
    children,
    ...heading
}: ComponentProps<typeof SectionHeader> & {
    readonly id: string;
    readonly children?: ReactNode;
}) {
    return (
        <Card
            id={id}
            className="scroll-mt-6 space-y-4 rounded-lg bg-primary-800 p-4 shadow-none sm:p-4"
        >
            <SectionHeader {...heading} />
            {children}
        </Card>
    );
}
