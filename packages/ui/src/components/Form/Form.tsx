import type { ComponentProps } from "react";

export function Form({
    onSubmit,
    noValidate = false,
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
