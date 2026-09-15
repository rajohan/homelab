import logo from "../../assets/rajohan-mark.svg";
import { cn } from "../../lib/classNames";

export function Brand({
    className,
    subtitle = "Homelab",
}: {
    readonly className?: string;
    readonly subtitle?: string;
}) {
    return (
        <span className={cn("inline-flex items-center gap-3", className)}>
            <img src={logo} alt="" width={40} height={40} className="size-10 shrink-0" />
            <span className="min-w-0">
                <span className="block text-lg font-semibold tracking-tight text-primary-50">
                    Rajohan
                </span>
                <span className="block text-xs font-medium text-primary-400">
                    {subtitle}
                </span>
            </span>
        </span>
    );
}
