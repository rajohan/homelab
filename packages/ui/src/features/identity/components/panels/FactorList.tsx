import { Trash2 } from "lucide-react";

import { IconButton } from "../../../../index";
import { formatDateTime } from "../../../../lib/formatDateTime";
import type { AccountPanelProps } from "../../types";

/**
 * List one kind of authenticator with consistent timestamps and removal controls.
 * @returns The enrolled methods or a contextual empty state.
 */
export function FactorList({
    data,
    kind,
    onAction,
}: AccountPanelProps & { readonly kind: "webauthn" | "totp" }) {
    const factors = data.factors.filter((factor) => factor.kind === kind);
    if (factors.length === 0)
        return (
            <p className="rounded-lg border border-primary-700 bg-primary-900/40 p-3 text-sm text-primary-400">
                No {kind === "webauthn" ? "security keys" : "authenticator apps"}{" "}
                registered.
            </p>
        );
    return (
        <ul className="space-y-2">
            {factors.map((factor) => (
                <li
                    key={factor.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary-700 bg-primary-900/40 p-3"
                >
                    <div className="min-w-0 flex-1">
                        <p className="font-medium wrap-anywhere">{factor.label}</p>
                        <p className="mt-1 text-xs text-primary-400">
                            {factor.lastUsedAt
                                ? `Last used ${formatDateTime(factor.lastUsedAt)}`
                                : "Not used yet"}
                        </p>
                    </div>
                    <IconButton
                        size="sm"
                        variant="danger"
                        icon={Trash2}
                        label={`Remove ${factor.label}`}
                        onClick={() =>
                            onAction({
                                kind: "remove",
                                factorKind: kind,
                                id: factor.id,
                                label: factor.label,
                            })
                        }
                    />
                </li>
            ))}
        </ul>
    );
}
