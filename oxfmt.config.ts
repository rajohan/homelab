import { defineConfig } from "oxfmt";

export default defineConfig({
    endOfLine: "lf",
    ignorePatterns: [
        "CHANGELOG.md",
        "**/coverage/**",
        "**/dist/**",
        "**/node_modules/**",
        "bun.lock",
        "**/*.min.css",
        "**/*.min.js",
    ],
    printWidth: 90,
    semi: true,
    singleQuote: false,
    jsxSingleQuote: false,
    sortImports: true,
    sortPackageJson: true,
    sortTailwindcss: {
        functions: ["clsx", "cn", "twMerge"],
        stylesheet: "apps/dashboard/src/styles.css",
    },
    tabWidth: 4,
    trailingComma: "es5",
    useTabs: false,
    overrides: [
        { files: ["*.yaml", "*.yml"], options: { tabWidth: 2 } },
        {
            files: [".bun-test-timings.json", ".bun-browser-test-timings.json"],
            options: { tabWidth: 2 },
        },
    ],
});
