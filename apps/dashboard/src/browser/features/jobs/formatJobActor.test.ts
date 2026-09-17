import { expect, test } from "bun:test";

import { formatJobActor } from "./formatJobActor";

test("job actors display User without changing machine identities", () => {
    expect(formatJobActor("human:operator-id")).toBe("User: operator-id");
    expect(formatJobActor("system:scheduler")).toBe("system:scheduler");
});
