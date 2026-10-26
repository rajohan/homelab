/**
 * Render a development-only frame for checking the real preview at bounded viewport sizes.
 * @param request - Local preview request; only predefined widths and routes are accepted.
 * @returns An HTML control page containing the synthetic application in its own viewport.
 */
export function miraViewport(request: Request): Response {
    const query = new URL(request.url).searchParams;
    const width =
        [390, 768, 1024, 1280].find((value) => String(value) === query.get("width")) ??
        390;
    const height = query.get("height") === "480" ? 480 : 660;
    const route =
        ["/mira", "/tasks", "/reports", "/mira-automations", "/settings"].find(
            (value) => value === query.get("route")
        ) ?? "/mira";
    return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Mira responsive preview</title>
    <style>body{margin:16px;background:#101114;color:#eee;font:14px system-ui}form{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}select,button{font:inherit;padding:8px;color:#eee;background:#28292f;border:1px solid #575860;border-radius:6px}label{display:flex;align-items:center;gap:8px}iframe{display:block;border:1px solid #575860;border-radius:8px}</style>
    <form><label>Width<select name="width">${[390, 768, 1024, 1280].map((value) => `<option ${value === width ? "selected" : ""}>${value}</option>`).join("")}</select></label>
    <label>Height<select name="height">${[480, 660].map((value) => `<option ${value === height ? "selected" : ""}>${value}</option>`).join("")}</select></label>
    <label>Page<select name="route">${["/mira", "/tasks", "/reports", "/mira-automations", "/settings"].map((value) => `<option ${value === route ? "selected" : ""}>${value}</option>`).join("")}</select></label><button>Apply viewport</button></form>
    <iframe title="Mira application preview" src="${route}" width="${width}" height="${height}"></iframe></html>`,
        {
            headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
            },
        }
    );
}
