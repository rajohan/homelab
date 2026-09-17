import type { OperationPrincipal } from "../automation/authentication";
import type { OperationsRuntime } from "./runtime";

export interface OperationsContext {
    readonly operations?: OperationsRuntime | undefined;
    readonly principal?: OperationPrincipal | undefined;
    readonly verifyHuman?: (() => Promise<OperationPrincipal>) | undefined;
}
