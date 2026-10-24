/**
 * Build a small self-contained PDF fixture with correct cross-reference offsets.
 * @param text - Synthetic ASCII text, without PDF string delimiters.
 * @returns A single-page PDF for parser and upload tests.
 */
export function syntheticPdf(text = "Synthetic Mira document"): Uint8Array {
    if (!/^[a-zA-Z0-9 .-]+$/.test(text))
        throw new Error("Use synthetic plain text only.");
    const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let document = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(document));
        document += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const start = Buffer.byteLength(document);
    document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1))
        document += `${String(offset).padStart(10, "0")} 00000 n \n`;
    document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
    return new TextEncoder().encode(document);
}
