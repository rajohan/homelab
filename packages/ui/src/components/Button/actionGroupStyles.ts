import { cn } from "../../lib/classNames";

export const actionGroupContainer = "@container/actions w-full min-w-0";

/**
 * Style related actions identically in React views and standalone Identity documents.
 * @param stretch - Whether controls share the available width in a horizontal row.
 * @param stacked - Keep one full-width control per row at every width.
 * @param align - Horizontal alignment when there is room for a row.
 * @returns Responsive Tailwind classes for the inner action row.
 */
export function actionGroupStyles(
    stretch = true,
    stacked = false,
    align: "start" | "end" = "end"
): string {
    return cn(
        "flex flex-col items-stretch gap-2",
        align === "start" ? "justify-start" : "justify-end",
        !stacked && "@min-[20rem]/actions:flex-row @min-[20rem]/actions:flex-wrap",
        !stacked &&
            "@min-[20rem]/actions:@max-[26.5rem]/actions:has-[>:nth-child(3_of_button,a,span)]:*:basis-full",
        "[&>:is(button,a)]:min-h-form-control [&>:is(button,a)]:max-w-full [&>:is(button,a)]:min-w-0 [&>:is(button,a)]:px-3 [&>:is(button,a)]:py-2 [&>:is(button,a)]:text-sm [&>:is(button,a)]:leading-5 [&>:is(button,a)]:wrap-anywhere [&>:is(button,a)]:whitespace-normal",
        !stacked &&
            (stretch
                ? "@min-[20rem]/actions:[&>:is(button,a)]:flex-[1_1_8.5rem]"
                : "@min-[20rem]/actions:[&>:is(button,a)]:min-w-34")
    );
}
