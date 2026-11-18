import {
    type MiraBrowserProfile,
    unrestrictedBrowserSites,
} from "@homelab/contracts/miraBrowser";
import { Button, ConfirmDialog, ErrorNotice } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

function profileDescription(profile: MiraBrowserProfile) {
    const sites = unrestrictedBrowserSites(profile.origins)
        ? "All websites"
        : profile.origins.join(", ");
    return `${profile.homeNetwork ? "Internet and home network" : "Internet"} · ${sites} · Created ${new Date(profile.createdAt).toLocaleString()} · ${profile.id.slice(-8)}`;
}

/** Let the operator remove saved sign-ins; session/profile selection belongs to Mira.
 * @returns Existing owned profiles and explicit deletion, without a startup form.
 */
export function BrowserProfileControls() {
    const [deleting, setDeleting] = useState<MiraBrowserProfile>();
    const profiles = useQuery({
        queryKey: ["operations", "mira", "browser-profiles"],
        queryFn: ({ signal }) => api.mira.browser.profiles.query(undefined, { signal }),
        refetchInterval: 5000,
        retry: false,
    });
    const remove = useOperation(
        (id: string, signal) => api.mira.browser.deleteProfile.mutate({ id }, { signal }),
        () => {
            setDeleting(undefined);
            void profiles.refetch();
        }
    );
    return (
        <div className="space-y-3">
            <p className="text-sm text-primary-300">
                Mira chooses a saved profile or a fresh session for each task. Saved
                profiles retain website sign-ins separately from your own browser.
            </p>
            {profiles.data?.map((profile) => (
                <div
                    key={profile.id}
                    className="flex flex-wrap items-center justify-between gap-2"
                >
                    <div className="min-w-0 text-sm wrap-anywhere">
                        <p>
                            {profile.name}
                            {profile.busy ? " · In use" : ""}
                        </p>
                        <p className="text-primary-400">{profileDescription(profile)}</p>
                    </div>
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={
                            profile.busy ||
                            profile.state !== "active" ||
                            Boolean(profiles.error)
                        }
                        onClick={() => setDeleting(profile)}
                    >
                        Delete saved sign-ins
                    </Button>
                </div>
            ))}
            {profiles.error && <ErrorNotice error={profiles.error} />}
            {remove.error && <ErrorNotice error={remove.error} />}
            {deleting && (
                <ConfirmDialog
                    title="Delete saved sign-ins"
                    description={`Delete ${deleting.name} (${profileDescription(deleting)}) and its saved website sign-ins? This cannot be undone.`}
                    confirmLabel="Delete saved sign-ins"
                    onConfirm={() => remove.mutateAsync(deleting.id)}
                    onClose={() => setDeleting(undefined)}
                />
            )}
        </div>
    );
}
