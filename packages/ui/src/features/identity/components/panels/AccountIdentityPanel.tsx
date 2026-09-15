import { UserRound } from "lucide-react";

import { Card } from "../../../../index";

/**
 * Identify the signed-in account without repeating its security settings.
 * @param props - The username of the account currently shown in Settings.
 * @returns A compact account identity card.
 */
export function AccountIdentityPanel({ username }: { readonly username: string }) {
    return (
        <Card className="flex items-center gap-3 rounded-lg bg-primary-800 p-4 shadow-none sm:p-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-700 text-accent-300">
                <UserRound size={20} aria-hidden="true" />
            </span>
            <p className="min-w-0 text-sm wrap-anywhere text-primary-300">
                Signed in as{" "}
                <strong className="font-semibold text-primary-50">{username}</strong>.
            </p>
        </Card>
    );
}
