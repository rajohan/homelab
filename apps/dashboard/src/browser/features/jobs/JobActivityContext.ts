import { createContext } from "react";

/** The shell's explicit manual-job acknowledgement, independent of background polling. */
export const JobActivityContext = createContext<(() => void) | undefined>(undefined);
