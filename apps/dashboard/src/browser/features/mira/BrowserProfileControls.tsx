import type { MiraBrowserProfile } from "@homelab/contracts/miraBrowser";
import {
    ActionGroup,
    Button,
    ConfirmDialog,
    ErrorNotice,
    FormField,
    Input,
    Select,
    Textarea,
} from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Choose a disposable or owned saved profile, with explicit creation and deletion controls.
 * @returns Shared profile controls and an explicit deletion confirmation.
 */
export function BrowserProfileControls({
    profiles,
    selected,
    onSelect,
    disabled,
}: {
    readonly profiles: MiraBrowserProfile[];
    readonly selected: string;
    readonly onSelect: (id: string) => void;
    readonly disabled: boolean;
}) {
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState("");
    const [sites, setSites] = useState("");
    const [deleting, setDeleting] = useState(false);
    const create = useOperation(
        (input: { name: string; origins: string[] }, signal) =>
            api.mira.browser.createProfile.mutate(input, { signal }),
        () => {
            setEditing(false);
            setName("");
            setSites("");
        }
    );
    const remove = useOperation(
        (id: string, signal) => api.mira.browser.deleteProfile.mutate({ id }, { signal }),
        () => {
            setDeleting(false);
            onSelect("");
        }
    );
    const profile = profiles.find((item) => item.id === selected);
    const busy = disabled || create.isPending || remove.isPending;
    return (
        <section className="space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4">
            <FormField label="Profile">
                <Select
                    label="Browser profile"
                    value={selected}
                    disabled={busy}
                    onChange={onSelect}
                    options={[
                        { value: "", label: "Temporary — fresh each time" },
                        ...profiles.map((item) => ({
                            value: item.id,
                            label: [
                                item.name,
                                item.state === "deleting" ? "Deleting" : "",
                                item.busy ? "In use" : "",
                            ]
                                .filter(Boolean)
                                .join(" / "),
                        })),
                    ]}
                />
                <p className="text-xs text-primary-400">
                    Saved profiles keep website sign-ins on the server. They belong to
                    your account.
                </p>
            </FormField>
            {profile && (
                <ul className="space-y-1 text-sm break-all text-primary-300">
                    {profile.origins.map((origin) => (
                        <li key={origin}>{origin}</li>
                    ))}
                </ul>
            )}
            <ActionGroup>
                <Button
                    variant="secondary"
                    disabled={busy || profiles.length >= 4}
                    onClick={() => setEditing(!editing)}
                >
                    {editing ? "Cancel new profile" : "New profile"}
                </Button>
                {profile && (
                    <Button
                        variant="danger"
                        disabled={busy || profile.busy || profile.state !== "active"}
                        onClick={() => setDeleting(true)}
                    >
                        Delete profile
                    </Button>
                )}
            </ActionGroup>
            {editing && (
                <form
                    className="space-y-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!busy)
                            create.mutate({
                                name,
                                origins: sites
                                    .split(/\r?\n/)
                                    .map((line) => line.trim())
                                    .filter(Boolean),
                            });
                    }}
                >
                    <FormField label="Profile name">
                        <Input
                            aria-label="Profile name"
                            value={name}
                            required
                            maxLength={80}
                            disabled={busy}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </FormField>
                    <FormField label="Profile websites">
                        <Textarea
                            aria-label="Profile websites"
                            value={sites}
                            required
                            rows={3}
                            maxLength={32_768}
                            disabled={busy}
                            onChange={(event) => setSites(event.target.value)}
                            placeholder="https://example.com"
                        />
                        <p className="text-xs text-primary-400">
                            One exact origin per line. Include any sign-in provider you
                            need. These sites cannot be expanded later.
                        </p>
                    </FormField>
                    <Button
                        type="submit"
                        fullWidth
                        busy={create.isPending}
                        disabled={busy}
                    >
                        Create profile
                    </Button>
                </form>
            )}
            {create.error && <ErrorNotice error={create.error} />}
            {remove.error && <ErrorNotice error={remove.error} />}
            {deleting && profile && (
                <ConfirmDialog
                    title="Delete browser profile"
                    description={`Delete ${profile.name} and its saved website sign-ins? This cannot be undone.`}
                    confirmLabel="Delete profile"
                    onConfirm={() => remove.mutateAsync(profile.id)}
                    onClose={() => setDeleting(false)}
                />
            )}
        </section>
    );
}
