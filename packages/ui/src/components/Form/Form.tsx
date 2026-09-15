import type { ComponentProps } from "react";

/**
 * Submit through the application handler without native navigation or validation popups by default.
 * @returns The component's rendered content for its current state.
 */
export function Form({
    onSubmit,
    noValidate = true,
    ...props
}: Omit<ComponentProps<"form">, "onSubmit"> & {
    readonly onSubmit: () => void | Promise<void>;
}) {
    return (
        <form
            {...props}
            noValidate={noValidate}
            onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void onSubmit();
            }}
        />
    );
}
