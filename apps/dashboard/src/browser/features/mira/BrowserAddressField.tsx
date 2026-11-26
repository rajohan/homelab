import { IconButton, Input } from "@homelab/ui";
import { ArrowRight, Globe2 } from "lucide-react";
import { type RefObject, useState } from "react";

/** Edit the address of the selected Chromium tab independently of status polling.
 * @returns A selectable current address and a one-shot navigation form for the operator in control.
 */
export function BrowserAddressField({
    url,
    readOnly,
    blocked,
    field,
    onNavigate,
}: {
    readonly url: string | null;
    readonly readOnly: boolean;
    readonly blocked: boolean;
    readonly field: RefObject<HTMLInputElement | null>;
    readonly onNavigate: (url: string) => void;
}) {
    const [draft, setDraft] = useState<string>();
    const [error, setError] = useState("");
    return (
        <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
                event.preventDefault();
                const value = (draft ?? url ?? "").trim();
                if (readOnly || blocked || !value) return;
                try {
                    const address = new URL(
                        /^[a-z][a-z\d+.-]*:/i.test(value) &&
                            !/^[\w.-]+:\d+(?:[/?#]|$)/.test(value)
                            ? value
                            : "https://" + value
                    );
                    if (
                        !["http:", "https:"].includes(address.protocol) ||
                        address.username ||
                        address.password ||
                        address.href.length > 2048 ||
                        /[\s\\]/u.test(value)
                    )
                        throw new Error("Invalid browser address.");
                    onNavigate(address.href);
                    setDraft(undefined);
                    setError("");
                    field.current?.blur();
                } catch {
                    setError(
                        "Enter an HTTP or HTTPS address without embedded credentials."
                    );
                }
            }}
        >
            <div className="relative flex items-center">
                <Globe2
                    size={14}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 z-1 text-primary-400"
                />
                <Input
                    ref={field}
                    aria-label="Browser address"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="none"
                    inputMode="url"
                    enterKeyHint="go"
                    placeholder={readOnly ? "New tab" : "Enter a web address"}
                    readOnly={readOnly}
                    maxLength={2048}
                    title={url ?? "New tab"}
                    value={readOnly ? (url ?? "") : (draft ?? url ?? "")}
                    aria-invalid={Boolean(error)}
                    className="h-10 min-h-10 w-full rounded-lg border-primary-700 bg-surface-panel pr-9 pl-8 text-sm"
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        setError("");
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            setDraft(undefined);
                            setError("");
                            field.current?.blur();
                        }
                    }}
                />
                {!readOnly && draft !== undefined && (
                    <IconButton
                        type="submit"
                        size="sm"
                        icon={ArrowRight}
                        label="Go to address"
                        disabled={blocked || !draft.trim()}
                        className="absolute right-0.5 size-9 min-h-9 [&_svg]:size-4"
                    />
                )}
            </div>
            {error && (
                <p role="alert" className="mt-1 text-xs text-red-300">
                    {error}
                </p>
            )}
        </form>
    );
}
