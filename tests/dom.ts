import { afterAll, afterEach, expect } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:3100" });
const { cleanup } = await import("@testing-library/react");
const { default: defaultMatchers, ...namedMatchers } =
    await import("@testing-library/jest-dom/matchers");
expect.extend(defaultMatchers ?? namedMatchers);

afterEach(() => {
    cleanup();
    document.body.replaceChildren();
});

afterAll(async () => {
    await GlobalRegistrator.unregister();
});
