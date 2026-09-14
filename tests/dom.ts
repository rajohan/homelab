import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3100" });
const { cleanup } = await import("@testing-library/react");

afterEach(() => {
    cleanup();
    document.body.replaceChildren();
});

afterAll(async () => {
    await GlobalRegistrator.unregister();
});
