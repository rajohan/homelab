import type { ComponentProps, ReactNode } from "react";

import { SectionPanel } from "../../../../index";

/**
 * Present a compact account-settings section with consistent headings and action placement.
 * @returns A labelled surface that stacks its actions on narrow screens.
 */
export function SettingsSection({
    id,
    children,
    ...heading
}: Omit<ComponentProps<typeof SectionPanel>, "children"> & {
    readonly id: string;
    readonly children?: ReactNode;
}) {
    return (
        <SectionPanel
            {...heading}
            id={id}
            className="scroll-mt-18"
            compactActions={false}
        >
            {children}
        </SectionPanel>
    );
}
