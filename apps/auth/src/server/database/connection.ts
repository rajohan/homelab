import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

/**
 * Open the bounded Bun SQL pool and its Drizzle database interface.
 * @param url - The PostgreSQL connection URL, including deployment TLS settings.
 * @param maximumConnections - The pool ceiling; deployment services divide their fixed budget.
 * @returns The pool client and database handle; the caller must close the client.
 */
export function connectAuthDatabase(url: string, maximumConnections = 8) {
    const client = new SQL(url, {
        max: maximumConnections,
        idleTimeout: 20,
        connectionTimeout: 10,
    });
    const database = drizzle({ client });
    return { client, database };
}

export type AuthDatabase = ReturnType<typeof connectAuthDatabase>["database"];
export type AuthTransaction = Parameters<Parameters<AuthDatabase["transaction"]>[0]>[0];
export type AuthStore = AuthDatabase | AuthTransaction;
