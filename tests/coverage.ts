import { executableSources } from "../scripts/testing/coverageInventory";

// Bun only instruments loaded modules. Load side-effect-free modules in their
// correct runtime so uncalled functions count as uncovered instead of disappearing.
// Browser entry points are mounted and unmounted by their component smoke tests.
for (const file of await executableSources()) {
    const browser = file.includes("/src/browser/") || file.endsWith(".tsx");
    if (file.endsWith("/src/browser/main.tsx")) continue;
    if (browser !== (process.env.HOMELAB_COVERAGE_GROUP === "component")) continue;
    await import(new URL("../" + file, import.meta.url).href);
}
