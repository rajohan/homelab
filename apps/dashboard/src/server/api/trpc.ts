import { initTRPC, TRPCError } from "@trpc/server";
import { Effect } from "effect";
import superjson from "superjson";

import type { OperationsContext } from "../operations/context";
import { OperationFailure } from "../operations/errors";

export const trpc = initTRPC
    .context<OperationsContext>()
    .create({ transformer: superjson });

/**
 * Execute a domain workflow through Effect and expose only reviewed application failures.
 * @param operation - One bounded request workflow.
 * @returns The successful workflow result.
 */
export async function runOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = await Effect.runPromise(
        Effect.tryPromise({ try: operation, catch: (error: unknown) => error }).pipe(
            Effect.result
        )
    );
    if (result._tag === "Success") return result.success;
    const error = result.failure;
    if (error instanceof OperationFailure)
        throw new TRPCError({ code: error.code, message: error.message });
    throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The operation could not be completed. Refresh before trying again.",
    });
}
