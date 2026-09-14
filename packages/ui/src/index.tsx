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
    return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Button({
    className = "",
    type = "button",
    ...props
}: ComponentProps<"button">) {
    return <button type={type} className={`button ${className}`} {...props} />;
}
