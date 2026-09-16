import { TriangleAlert } from "lucide-react";

import { Button } from "../Button/Button";
import { Card } from "../Card/Card";

/**
 * Present a recoverable error state with an optional retry action.
 * @returns The component's rendered content for its current state.
 */
export function ErrorState({
    onRetry,
    title = "This view couldn't load",
}: {
    readonly onRetry: () => void;
    readonly title?: string;
}) {
    return (
        <Card role="alert" className="mx-auto w-full max-w-lg space-y-5">
            <span className="grid size-11 place-items-center rounded-lg bg-red-500/10 text-red-400">
                <TriangleAlert size={22} aria-hidden="true" />
            </span>
            <div>
                <h1 className="text-xl font-semibold">{title}</h1>
                <p className="mt-2 text-sm leading-6 text-primary-400">
                    Something prevented this view from rendering. Try again, or reload the
                    page if the problem continues.
                </p>
            </div>
            <Button onClick={onRetry}>Try again</Button>
        </Card>
    );
}
