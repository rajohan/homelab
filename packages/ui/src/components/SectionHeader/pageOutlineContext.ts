import { createContext, type Dispatch, type SetStateAction } from "react";

export interface PageOutline {
    readonly path: string;
    readonly label: string;
    readonly items: readonly { id: string; label: string }[];
    readonly current: string;
}

/** Publish the active page's section links to the application navigation. */
export const PageOutlineContext = createContext<Dispatch<
    SetStateAction<PageOutline | null>
> | null>(null);
