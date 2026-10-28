import type { MiraContext } from "../data/context";
import type { RuntimeTool } from "../runtime/protocol";

/** Trusted action scope created only after the tool receipt commits. */
export interface MiraToolContext extends MiraContext {
    readonly receiptId: string;
}

/** Fixed service-owned behavior; no lifecycle hook is accepted from tool arguments. */
export interface MiraToolDefinition extends Omit<RuntimeTool, "execute"> {
    automatic: boolean;
    transactional?: boolean;
    commitsIndependently?: boolean;
    confirmation?: boolean;
    structuredOutput?: boolean;
    action: (
        input: unknown,
        signal: AbortSignal,
        context: MiraToolContext
    ) => Promise<unknown>;
    finalize?: (context: MiraToolContext, signal: AbortSignal) => Promise<void>;
    onFailure?: (context: MiraToolContext) => Promise<void>;
}
