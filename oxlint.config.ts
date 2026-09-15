import reactEffectPlugin from "eslint-plugin-react-you-might-not-need-an-effect";
import { defineConfig, type OxlintOverride } from "oxlint";
import eslintRecommended from "oxlint-config-presets/@eslint/recommended.json" with { type: "json" };
import typescriptRecommended from "oxlint-config-presets/@typescript-eslint/recommended-type-checked.json" with { type: "json" };
import importRecommended from "oxlint-config-presets/import/recommended.json" with { type: "json" };
import jestRecommended from "oxlint-config-presets/jest/recommended.json" with { type: "json" };
import jsdocRecommended from "oxlint-config-presets/jsdoc/recommended-typescript-error.json" with { type: "json" };
import jsxA11yRecommended from "oxlint-config-presets/jsx-a11y/recommended.json" with { type: "json" };
import nodeRecommended from "oxlint-config-presets/n/recommended-module.json" with { type: "json" };
import promiseRecommended from "oxlint-config-presets/promise/recommended.json" with { type: "json" };
import reactHooksRecommended from "oxlint-config-presets/react-hooks/recommended.json" with { type: "json" };
import reactRefreshRecommended from "oxlint-config-presets/react-refresh/recommended.json" with { type: "json" };
import reactJsxRuntime from "oxlint-config-presets/react/jsx-runtime.json" with { type: "json" };
import reactRecommended from "oxlint-config-presets/react/recommended.json" with { type: "json" };
import unicornRecommended from "oxlint-config-presets/unicorn/recommended.json" with { type: "json" };

interface ReactEffectPlugin {
    readonly configs: {
        readonly strict: { readonly rules: OxlintOverride["rules"] };
    };
}

const reactEffectStrictRules = (reactEffectPlugin as unknown as ReactEffectPlugin).configs
    .strict.rules;
const testFiles = ["**/*.test.{ts,tsx}", "tests/**/*.ts"];
const browserFiles = [
    "apps/dashboard/src/browser/main.tsx",
    "apps/dashboard/src/browser/api/client.ts",
    "apps/dashboard/src/browser/**/*.{ts,tsx}",
    "apps/auth/src/browser/**/*.{ts,tsx}",
    "packages/ui/src/**/*.{ts,tsx}",
];
const serverFiles = ["apps/auth/src/**/*.{ts,tsx}", "apps/dashboard/src/**/*.{ts,tsx}"];
const compilerManagedImports = [
    {
        name: "react",
        importNames: ["memo", "useMemo", "useCallback"],
        message:
            "React Compiler owns memoization; do not add manual memo, useMemo or useCallback.",
    },
];
const appImports = ["**/apps/**", "@homelab/auth", "@homelab/dashboard"];
const serverImports = [
    "bun",
    "bun:*",
    "node:*",
    "effect",
    "effect/*",
    "@trpc/server",
    "@trpc/server/*",
    "@simplewebauthn/server",
    "@simplewebauthn/server/*",
    "drizzle-orm",
    "drizzle-orm/*",
];

export default defineConfig({
    categories: { correctness: "error" },
    env: { builtin: true, es2026: true },
    extends: [
        eslintRecommended,
        typescriptRecommended,
        importRecommended,
        unicornRecommended,
        reactRecommended,
        reactJsxRuntime,
        reactHooksRecommended,
        reactRefreshRecommended,
        jsxA11yRecommended,
        jestRecommended,
        jsdocRecommended,
        nodeRecommended,
        promiseRecommended,
    ],
    ignorePatterns: [
        "**/coverage/**",
        "**/dist/**",
        "**/node_modules/**",
        "**/*.log",
        "**/*.tsbuildinfo",
        ".git/**",
        ".vscode/**",
    ],
    options: {
        denyWarnings: true,
        reportUnusedDisableDirectives: "error",
        typeAware: true,
        typeCheck: true,
    },
    plugins: [
        "eslint",
        "import",
        "jest",
        "jsdoc",
        "jsx-a11y",
        "node",
        "oxc",
        "promise",
        "react",
        "react-perf",
        "typescript",
        "unicorn",
    ],
    rules: {
        eqeqeq: "error",
        "typescript/no-explicit-any": "error",
        "typescript/consistent-type-imports": "error",
        "import/no-cycle": "error",
        "jsdoc/require-param": [
            "error",
            {
                checkDestructured: false,
                checkDestructuredRoots: false,
                interfaceExemptsParamsCheck: true,
            },
        ],
        "jsx-a11y/no-noninteractive-tabindex": [
            "error",
            {
                roles: ["log", "region", "tabpanel"],
                tags: ["section"],
            },
        ],
        "jsdoc/require-throws-description": "error",
        "jsdoc/require-yields-description": "error",
        "react/unsupported-syntax": "error",
        "react/no-multi-comp": "error",
        "require-await": "off",
        "typescript/require-await": "error",
        "unicorn/no-null": "off",
        // Oxfmt owns hexadecimal casing, matching the previous project.
        "unicorn/number-literal-case": "off",
        "unicorn/no-useless-undefined": ["error", { checkArguments: false }],
        "unicorn/filename-case": [
            "error",
            { cases: { camelCase: true, pascalCase: true } },
        ],
        "unicorn/max-nested-calls": ["error", { max: 6 }],
    },
    settings: {
        react: { version: "19.3.0" },
        tailwindcss: { entryPoint: "apps/dashboard/src/styles.css" },
    },
    overrides: [
        {
            files: [...serverFiles, "scripts/**/*.ts", "*.config.ts", ...testFiles],
            env: { node: true },
            globals: { Bun: "readonly" },
        },
        {
            files: browserFiles,
            excludeFiles: testFiles,
            env: { browser: true },
            jsPlugins: [
                "eslint-plugin-react-you-might-not-need-an-effect",
                "oxlint-tailwindcss",
            ],
            rules: {
                ...reactEffectStrictRules,
                "tailwindcss/consistent-variant-order": "error",
                "tailwindcss/enforce-canonical": "error",
                // Match IntelliSense's numeric scale suggestions without unsafe autofixes.
                "tailwindcss/prefer-scale-token": ["error", { step: 0.25 }],
                "tailwindcss/enforce-consistent-important-position": "error",
                "tailwindcss/enforce-consistent-variable-syntax": "error",
                "tailwindcss/enforce-negative-arbitrary-values": "error",
                "tailwindcss/enforce-shorthand": "error",
                "tailwindcss/no-conflicting-classes": "error",
                "tailwindcss/no-dark-without-light": "error",
                "tailwindcss/no-deprecated-classes": "error",
                "tailwindcss/no-duplicate-classes": "error",
                "tailwindcss/no-unknown-classes": [
                    "error",
                    { ignorePrefixes: ["language-"] },
                ],
                "tailwindcss/no-unnecessary-arbitrary-value": "error",
                "tailwindcss/no-unnecessary-whitespace": "error",
                "no-restricted-globals": [
                    "error",
                    {
                        checkGlobalObject: true,
                        globals: ["Bun", "Buffer", "Deno", "process"],
                    },
                ],
                "no-restricted-imports": [
                    "error",
                    {
                        paths: compilerManagedImports,
                        patterns: [
                            {
                                group: [
                                    ...serverImports,
                                    "**/scripts/**",
                                    "**/server/**",
                                    "!**/server/api/router",
                                    "**/http",
                                    "**/http.ts",
                                    "**/system",
                                    "**/system.ts",
                                ],
                                message:
                                    "Browser code must not import server runtime or repository scripts.",
                            },
                            {
                                group: ["**/api", "**/api.ts", "**/server/api/router"],
                                allowTypeImports: true,
                                message:
                                    "Only erased tRPC router types may cross from server API to browser code.",
                            },
                        ],
                    },
                ],
            },
        },
        {
            files: ["packages/ui/src/**/*.{ts,tsx}"],
            excludeFiles: testFiles,
            rules: {
                "no-restricted-imports": [
                    "error",
                    {
                        paths: compilerManagedImports,
                        patterns: [
                            {
                                group: [...appImports, ...serverImports],
                                message:
                                    "Shared UI must remain browser-safe and independent of applications.",
                            },
                        ],
                    },
                ],
            },
        },
        {
            files: ["packages/ui/src/components/**/*.{ts,tsx}"],
            excludeFiles: testFiles,
            rules: {
                "no-restricted-imports": [
                    "error",
                    {
                        paths: compilerManagedImports,
                        patterns: [
                            {
                                group: [
                                    ...appImports,
                                    ...serverImports,
                                    "**/features/**",
                                    "@homelab/ui/identity",
                                    "@homelab/ui/identity/*",
                                ],
                                message:
                                    "Generic UI primitives must not depend on identity features, applications or server modules.",
                            },
                        ],
                    },
                ],
            },
        },
        {
            files: ["packages/contracts/src/**/*.{ts,tsx}"],
            excludeFiles: testFiles,
            rules: {
                "no-restricted-globals": [
                    "error",
                    {
                        checkGlobalObject: true,
                        globals: [
                            "Bun",
                            "Buffer",
                            "Deno",
                            "document",
                            "navigator",
                            "process",
                            "window",
                        ],
                    },
                ],
                "no-restricted-imports": [
                    "error",
                    {
                        paths: compilerManagedImports,
                        patterns: [
                            {
                                group: [
                                    ...appImports,
                                    ...serverImports,
                                    "@homelab/ui",
                                    "react",
                                    "react-dom",
                                    "react-dom/*",
                                ],
                                message:
                                    "Contracts must remain environment-neutral and independent of UI or application implementations.",
                            },
                        ],
                    },
                ],
            },
        },
        {
            files: ["packages/**/*.test.{ts,tsx}"],
            rules: {
                "no-restricted-imports": [
                    "error",
                    {
                        paths: compilerManagedImports,
                        patterns: [
                            {
                                group: appImports,
                                message:
                                    "Shared package tests must not depend on application internals.",
                            },
                        ],
                    },
                ],
            },
        },
        {
            files: serverFiles,
            excludeFiles: [...browserFiles, ...testFiles],
            rules: {
                "no-console": "error",
                "no-restricted-imports": [
                    "error",
                    {
                        paths: compilerManagedImports,
                        patterns: [
                            {
                                group: [
                                    "**/browser/**",
                                    "**/scripts/**",
                                    "@homelab/ui",
                                    "**/app",
                                    "**/app.tsx",
                                    "**/main.tsx",
                                    "**/client",
                                    "**/client.ts",
                                ],
                                message:
                                    "Server modules must not depend on browser components or repository scripts.",
                            },
                        ],
                    },
                ],
            },
        },
        {
            files: serverFiles,
            excludeFiles: [
                ...browserFiles,
                ...testFiles,
                "apps/*/src/server/config/environment.ts",
            ],
            rules: {
                "no-restricted-properties": [
                    "error",
                    {
                        object: "process",
                        property: "env",
                        message:
                            "Read process environment through the application's typed environment module.",
                    },
                    {
                        object: "Bun",
                        property: "env",
                        message:
                            "Read process environment through the application's typed environment module.",
                    },
                    {
                        object: "Deno",
                        property: "env",
                        message:
                            "Read process environment through the application's typed environment module.",
                    },
                ],
            },
        },
        {
            files: ["apps/auth/src/**/*.{ts,tsx}"],
            rules: {
                "no-restricted-imports": [
                    "error",
                    {
                        paths: compilerManagedImports,
                        patterns: [
                            {
                                group: [
                                    "@homelab/dashboard",
                                    "**/dashboard/**",
                                    "**/scripts/**",
                                    "**/openclaw/**",
                                ],
                                message:
                                    "Identity must remain independent of dashboard and administrative integrations.",
                            },
                            {
                                group: ["**/browser/**", "@homelab/ui"],
                                message:
                                    "Auth server modules must not import browser UI.",
                            },
                        ],
                    },
                ],
            },
            excludeFiles: ["apps/auth/src/browser/**/*.{ts,tsx}"],
        },
        {
            files: ["scripts/**/*.ts", "*.config.ts"],
            // The isolated development harness composes both apps with fake dependencies.
            excludeFiles: ["scripts/devIdentity.ts"],
            rules: {
                "no-restricted-imports": [
                    "error",
                    {
                        paths: compilerManagedImports,
                        patterns: [
                            {
                                group: [
                                    "**/apps/**",
                                    "@homelab/auth",
                                    "@homelab/dashboard",
                                    "@homelab/ui",
                                ],
                                message:
                                    "Repository tooling must not execute application internals.",
                            },
                        ],
                    },
                ],
            },
        },
    ],
});
