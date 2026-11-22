import { fileURLToPath } from "node:url";

import tailwind from "bun-plugin-tailwind";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { LogoutPresentation } from "./compileLogoutPresentation";
import { type LogoutStep, LogoutView } from "./LogoutView";

const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("logout.css", import.meta.url))],
    plugins: [tailwind],
    minify: true,
});
const stylesheet = result.outputs.find((output) => output.path.endsWith(".css"));
if (!result.success || !stylesheet) {
    throw new AggregateError(result.logs, "Unable to build the sign-out stylesheet");
}
function renderStep(step: LogoutStep, title: string, description: string) {
    return {
        title,
        markup: renderToStaticMarkup(
            createElement(LogoutView, { step, title, description })
        ),
    };
}

const scope = "This ends this browser's identity session and its connected grants.";
const presentation: LogoutPresentation = {
    style: await stylesheet.text(),
    views: {
        confirm: renderStep("confirm", "Sign out of Homelab?", scope),
        finishing: renderStep("finishing", "Signing out", scope),
        complete: renderStep("complete", "You are signed out", "You can close this tab."),
    },
};
await Bun.write(Bun.stdout, JSON.stringify(presentation));
