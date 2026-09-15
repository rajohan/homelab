/**
 * Browser API calls must prove their origin before authentication records activity.
 * Same-site siblings are not trusted; a missing header is not proof of same-origin.
 * @returns Whether the request supplies consistent same-origin evidence.
 */
export function isSameOriginApiRequest(request: Request, origin: string): boolean {
    const requestOrigin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (requestOrigin !== null && requestOrigin !== origin) return false;
    if (site !== null && site !== "same-origin") return false;
    return request.method === "GET"
        ? site === "same-origin" || requestOrigin === origin
        : requestOrigin === origin;
}
