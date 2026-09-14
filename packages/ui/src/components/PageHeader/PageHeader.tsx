import type { ReactNode } from "react";
export function PageHeader({
    title,
    description,
    eyebrow,
}: {
    title: string;
    description?: ReactNode;
    eyebrow?: string;
}) {
    return (
        <header className="mb-7.25 max-[640px]:mb-5.75">
            {eyebrow && (
                <p className="text-[0.65rem] font-[650] tracking-[0.12em] text-[#68798e] uppercase">
                    {eyebrow}
                </p>
            )}
            <h1 className="mt-2.5 mb-3.25 text-[clamp(1.8rem,3vw,2.5rem)] leading-[1.2] font-[650] tracking-[-0.045em]">
                {title}
            </h1>
            {description && (
                <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                    {description}
                </p>
            )}
        </header>
    );
}
