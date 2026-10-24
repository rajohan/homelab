import { getDocumentProxy } from "unpdf";

/**
 * Extract bounded PDF text in a separate killable process without provider credentials.
 * @returns Completion after one stdin document is parsed and one JSON result is written.
 */
export async function main(): Promise<void> {
    const bytes = await Bun.stdin.bytes();
    if (bytes.byteLength > 26_214_400) throw new Error("PDF input exceeds limit.");
    const pdf = await getDocumentProxy(bytes, {
        verbosity: 0,
        useSystemFonts: false,
        disableFontFace: true,
        useWorkerFetch: false,
    });
    try {
        let text = "";
        const pages = Math.min(pdf.numPages, 100);
        for (
            let pageNumber = 1;
            pageNumber <= pages && text.length < 256_000;
            pageNumber++
        ) {
            const page = await pdf.getPage(pageNumber);
            const content = await page.getTextContent();
            text += `\n[Page ${pageNumber}]\n`;
            for (const item of content.items) {
                if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
                if (text.length >= 256_000) break;
            }
            page.cleanup();
        }
        process.stdout.write(
            JSON.stringify({
                text: text.slice(0, 256_000),
                pages: pdf.numPages,
                truncated: pdf.numPages > 100 || text.length >= 256_000,
            })
        );
    } finally {
        await pdf.loadingTask.destroy();
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch {
        process.exitCode = 1;
    }
}
