import { systemStatusSchema } from "@homelab/contracts";
import { initTRPC } from "@trpc/server";
import { Effect } from "effect";
import superjson from "superjson";

import { readSystemStatus, SystemStatusLive } from "./system";

const trpc = initTRPC.create({ transformer: superjson });

// This read-only foundation API relies on the private deployment boundary. It does
// not implement an application login or accept identity from forwarded headers.
export const appRouter = trpc.router({
    system: trpc.router({
        status: trpc.procedure
            .output(systemStatusSchema)
            .query(() =>
                Effect.runPromise(readSystemStatus.pipe(Effect.provide(SystemStatusLive)))
            ),
    }),
});

export type AppRouter = typeof appRouter;
