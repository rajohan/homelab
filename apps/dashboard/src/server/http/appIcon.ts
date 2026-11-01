import artwork from "../../../../../packages/ui/src/assets/rajohan.svg" with { type: "text" };

// The manifest needs a stable URL; HTML-linked icons keep Bun's hashed asset URLs.
export const dashboardAppIcon = new Response(artwork, {
    headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
});
