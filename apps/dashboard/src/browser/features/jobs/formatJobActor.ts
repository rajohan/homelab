/**
 * Present audit actors using user-facing terminology without rewriting stored identifiers.
 * @param actor - The typed actor identifier recorded with a job or audit event.
 * @returns A readable actor label with the original identifier preserved.
 */
export function formatJobActor(actor: string): string {
    return actor.startsWith("human:") ? `User: ${actor.slice(6)}` : actor;
}
