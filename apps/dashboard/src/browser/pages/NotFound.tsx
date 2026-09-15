import { Link } from "@tanstack/react-router";

/**
 * Offer navigation back to the overview when no dashboard route matches.
 * @returns The component's rendered content for its current state.
 */
export function NotFound() {
    return (
        <>
            <h1 className="text-[clamp(1.8rem,3vw,2.5rem)] leading-[1.2] font-[650] tracking-[-0.045em]">
                Page not found
            </h1>
            <p className="text-[0.925rem] leading-[1.7] text-primary-300">
                <Link to="/">Return to overview</Link>
            </p>
        </>
    );
}
