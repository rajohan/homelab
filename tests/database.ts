import { SQL } from "bun";

/**
 * Allocate a database per concurrently running suite on the disposable test server.
 * @returns The suite URL and cleanup function.
 */
export async function createTestDatabase() {
    const base = process.env.HOMELAB_TEST_DATABASE_URL;
    if (!base) throw new Error("HOMELAB_TEST_DATABASE_URL is required");
    const target = new URL(base);
    if (
        !["localhost", "127.0.0.1"].includes(target.hostname) ||
        target.pathname !== "/homelab_auth_test"
    )
        throw new Error("Refusing a non-test database");
    const name = "homelab_test_" + crypto.randomUUID().replaceAll("-", "");
    const admin = new SQL(base, { max: 1 });
    try {
        await admin.unsafe(`CREATE DATABASE "${name}"`);
    } catch (error) {
        await admin.close();
        throw error;
    }
    target.pathname = "/" + name;
    return {
        url: target.href,
        async close() {
            try {
                await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
            } finally {
                await admin.close();
            }
        },
    };
}
