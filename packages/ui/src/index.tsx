import type { ComponentProps, ReactNode } from "react";

export function Card({ className = "", ...props }: ComponentProps<"section">) {
    return <section className={`card ${className}`} {...props} />;
}

export function Badge({
    children,
    tone = "neutral",
}: {
    children: ReactNode;
    tone?: "neutral" | "positive" | "warning";
}) {
    const classes = {
        neutral: "badge",
        positive: "badge badge-positive",
        warning: "badge badge-warning",
    } as const;
    return <span className={classes[tone]}>{children}</span>;
}

export function Button({
    className = "",
    type = "button",
    ...props
}: ComponentProps<"button">) {
    return <button type={type} className={`button ${className}`} {...props} />;
}
