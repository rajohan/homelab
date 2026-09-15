/**
 * Download the one-time codes already displayed in the browser without contacting a server.
 * @param codes - The current recovery-code set, never stored automatically.
 */
export function downloadRecoveryCodes(codes: readonly string[]): void {
    const contents = [
        "Homelab recovery codes",
        "Each code can be used once. Store these offline.",
        "",
        ...codes,
        "",
    ].join("\n");
    const url = URL.createObjectURL(
        new Blob([contents], { type: "text/plain;charset=utf-8" })
    );
    try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "homelab-recovery-codes.txt";
        anchor.click();
    } finally {
        URL.revokeObjectURL(url);
    }
}
