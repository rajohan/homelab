import { MiraFailure } from "@homelab/mira/data/context";
import {
    deleteMiraFile,
    miraFileLimit,
    readMiraFile,
    saveMiraFile,
} from "@homelab/mira/data/files";
import { readMiraPdf } from "@homelab/mira/files/content";
import { Effect } from "effect";

import { boundedRequestBody } from "../http/requestBody";
import { authorizedOperations } from "../operations/authorization";
import type { OperationsContext } from "../operations/context";
import { OperationFailure } from "../operations/errors";

/**
 * Serve authenticated, same-origin file operations outside the small JSON RPC budget.
 * @param request - Request whose origin and browser session were verified before buffering.
 * @param context - Server-resolved operator identity and scoped storage configuration.
 * @returns A bounded upload response, passive download, or public operation failure.
 */
export async function miraFileRequest(
    request: Request,
    context: OperationsContext
): Promise<Response> {
    const { operations, principal } = authorizedOperations(context, "jobs:read");
    if (principal.kind !== "human")
        throw new OperationFailure(
            "FORBIDDEN",
            "Mira files require a signed-in operator."
        );
    const mira = {
        client: operations.client,
        owner: principal.id,
        actor: `human:${principal.id}`,
    };
    const headers = {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'self'",
        "Referrer-Policy": "no-referrer",
    };
    const result = await Effect.runPromise(
        Effect.tryPromise({
            try: async () => {
                const url = new URL(request.url);
                const id = url.pathname.slice("/api/mira/files/".length);
                if (request.method === "POST" && url.pathname === "/api/mira/files") {
                    const bounded = await boundedRequestBody(request, miraFileLimit);
                    if (!bounded)
                        return Response.json(
                            { message: "Files must be 25 MiB or smaller." },
                            { status: 413, headers }
                        );
                    let name: string;
                    try {
                        name = decodeURIComponent(
                            request.headers.get("x-file-name") ?? ""
                        );
                    } catch {
                        throw new MiraFailure("BAD_REQUEST", "Invalid filename.");
                    }
                    const file = await saveMiraFile(mira, operations.miraFilesDirectory, {
                        id: request.headers.get("x-file-id") ?? "",
                        name,
                        bytes: new Uint8Array(await bounded.arrayBuffer()),
                    });
                    return Response.json(file, { status: 201, headers });
                }
                if (request.method === "DELETE" && id) {
                    await deleteMiraFile(mira, operations.miraFilesDirectory, id);
                    return new Response(null, { status: 204, headers });
                }
                if (request.method === "GET" && id) {
                    const file = await readMiraFile(
                        mira,
                        operations.miraFilesDirectory,
                        id
                    );
                    if (url.searchParams.get("preview") === "text") {
                        if (file.metadata.mediaType.startsWith("image/"))
                            throw new MiraFailure(
                                "BAD_REQUEST",
                                "Use the image preview for this file."
                            );
                        const document =
                            file.metadata.mediaType === "application/pdf"
                                ? await readMiraPdf(file.bytes, request.signal)
                                : {
                                      text: new TextDecoder().decode(file.bytes),
                                      truncated: false,
                                  };
                        return Response.json(
                            {
                                text: document.text.slice(0, 64_000),
                                truncated:
                                    document.truncated || document.text.length > 64_000,
                            },
                            { headers }
                        );
                    }
                    // PDFs download directly; text and passive raster formats can be previewed inline.
                    const inline =
                        url.searchParams.get("preview") === "1" &&
                        file.metadata.mediaType !== "application/pdf";
                    return new Response(Buffer.from(file.bytes), {
                        headers: {
                            ...headers,
                            "Content-Type": file.metadata.mediaType,
                            "Content-Length": String(file.metadata.bytes),
                            "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.metadata.name).replaceAll("'", "%27")}`,
                        },
                    });
                }
                return Response.json(
                    { message: "File operation not found." },
                    { status: 404, headers }
                );
            },
            catch: (error: unknown) => error,
        }).pipe(Effect.result)
    );
    if (result._tag === "Success") return result.success;
    if (result.failure instanceof MiraFailure)
        throw new OperationFailure(result.failure.code, result.failure.message);
    throw new OperationFailure(
        "BAD_REQUEST",
        "The file operation could not be completed. Check the file and try again."
    );
}
