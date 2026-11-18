import type { MiraRun } from "@homelab/contracts/mira";
import {
    connectedBrowserScope,
    internetBrowserScope,
    type miraBrowserAccessRequestSchema,
    publicBrowserScope,
} from "@homelab/contracts/miraBrowser";
import {
    ActionGroup,
    Badge,
    Button,
    ErrorNotice,
    formatDateTime,
    FormField,
    Input,
    LoadingState,
    Modal,
    SectionHeader,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Globe, Square } from "lucide-react";
import { useState } from "react";
import type * as v from "valibot";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { BrowserProfileControls } from "./BrowserProfileControls";
import { accessStatusTone } from "./statusTone";
import { browserAccessLabel, useBrowserAccess } from "./useBrowserAccess";

function siteLabel(origin: string) {
    if (origin === connectedBrowserScope) return "Internet and home network";
    return origin === publicBrowserScope || origin === internetBrowserScope
        ? "Public web"
        : origin;
}

/**
 * Show the automatic server browser and its optional saved sign-ins.
 * @returns Current status, an optional starting URL and immediate stop.
 */
export function BrowserAccessDialog({
    run,
    supportsImages,
    onClose,
}: {
    readonly run: MiraRun | null;
    readonly supportsImages: boolean;
    readonly onClose: () => void;
}) {
    const [initialUrl, setInitialUrl] = useState("");
    const [profileId, setProfileId] = useState("");
    const profiles = useQuery({
        queryKey: ["operations", "mira", "browser-profiles"],
        queryFn: ({ signal }) => api.mira.browser.profiles.query(undefined, { signal }),
        refetchInterval: 5000,
        retry: false,
    });
    const profile = profiles.data?.find((item) => item.id === profileId);
    const controls = useQuery({
        queryKey: ["operations", "mira", "controls"],
        queryFn: ({ signal }) => api.mira.controls.list.query(undefined, { signal }),
        refetchInterval: 5000,
        retry: false,
    });
    const accessQuery = useBrowserAccess(run);
    const access = accessQuery.data?.[0];
    const request = useOperation(
        (input: v.InferOutput<typeof miraBrowserAccessRequestSchema>, signal) =>
            api.mira.browser.request.mutate(input, { signal })
    );
    const stop = useOperation((id: string, signal) =>
        api.mira.browser.stop.mutate({ id }, { signal })
    );
    const running = run?.state === "running" && !run.cancelRequested && !run.automationId;
    const enabled =
        controls.data?.find((control) => control.key === "computer:browser")?.enabled ===
        true;
    const current = access && access.state !== "closed";
    const controlFresh =
        !controls.error &&
        !controls.isPending &&
        accessQuery.now - controls.dataUpdatedAt < 10_000;
    const ready =
        running &&
        supportsImages &&
        enabled &&
        controlFresh &&
        accessQuery.fresh &&
        (!profileId ||
            (profile?.state === "active" &&
                !profile.busy &&
                !profiles.error &&
                accessQuery.now - profiles.dataUpdatedAt < 10_000)) &&
        !current;
    return (
        <Modal
            title="Browser access"
            description="Mira can browse internet, home services and development previews for your request."
            onClose={onClose}
            dismissible={!request.isPending}
        >
            <div className="space-y-4">
                {access && (
                    <section className="space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4">
                        <SectionHeader
                            title="Server browser"
                            icon={Globe}
                            badge={
                                <Badge
                                    tone={accessStatusTone(
                                        browserAccessLabel(access, run, accessQuery.fresh)
                                    )}
                                >
                                    {browserAccessLabel(access, run, accessQuery.fresh)}
                                </Badge>
                            }
                            description={`Ends by ${formatDateTime(access.expiresAt)}`}
                        />
                        {access.origins.length > 0 && (
                            <ul className="space-y-1 text-sm break-all text-primary-300">
                                {access.origins.map((origin) => (
                                    <li key={origin}>{siteLabel(origin)}</li>
                                ))}
                            </ul>
                        )}
                        {current && (
                            <Button
                                variant="secondary"
                                fullWidth
                                busy={stop.isPending}
                                onClick={() => stop.mutate(access.id)}
                            >
                                <Square size={16} aria-hidden="true" />
                                Stop access
                            </Button>
                        )}
                    </section>
                )}
                {!running && (
                    <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-300">
                        Ask Mira to browse and the browser starts automatically. Access
                        ends when the run stops.
                    </p>
                )}
                {running && !supportsImages && (
                    <p className="text-sm text-primary-300">
                        Choose a model with image support before starting a
                        browser-assisted run.
                    </p>
                )}
                {controlFresh && !enabled && (
                    <p className="text-sm text-primary-300">
                        Browser access is paused. Enable Browser in Automations before
                        starting a session.
                    </p>
                )}
                {(controls.isPending || (run && accessQuery.isPending)) && (
                    <LoadingState label="Loading browser access…" />
                )}
                {controls.error && <ErrorNotice error={controls.error} />}
                {accessQuery.error && <ErrorNotice error={accessQuery.error} />}
                {(controls.error || accessQuery.error) && (
                    <Button
                        variant="secondary"
                        fullWidth
                        onClick={() => {
                            void controls.refetch();
                            void accessQuery.refetch();
                        }}
                    >
                        Refresh status
                    </Button>
                )}
                {!current && (
                    <>
                        <BrowserProfileControls
                            profiles={profiles.data ?? []}
                            selected={profileId}
                            disabled={
                                request.isPending ||
                                profiles.isPending ||
                                Boolean(profiles.error)
                            }
                            onSelect={(id) => {
                                setProfileId(id);
                                const chosen = profiles.data?.find(
                                    (item) => item.id === id
                                );
                                if (chosen) {
                                    setInitialUrl(chosen.origins[0] ?? "");
                                }
                            }}
                        />
                        {profiles.error && <ErrorNotice error={profiles.error} />}
                    </>
                )}
                {running && !current && (
                    <form
                        className="space-y-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (!ready || !run) return;
                            if (!URL.canParse(initialUrl.trim())) return;
                            request.mutate({
                                runId: run.id,
                                initialUrl: initialUrl.trim(),
                                ...(profile
                                    ? {
                                          network: profile.homeNetwork
                                              ? ("home" as const)
                                              : ("public" as const),
                                      }
                                    : {}),
                                origins: profile?.origins ?? [publicBrowserScope],
                                mode: "control",
                                ...(profileId ? { profileId } : {}),
                            });
                        }}
                    >
                        <FormField label="Starting URL">
                            <Input
                                aria-label="Starting URL"
                                type="url"
                                required
                                maxLength={2048}
                                value={initialUrl}
                                disabled={request.isPending}
                                onChange={(event) => setInitialUrl(event.target.value)}
                                placeholder="https://example.com/page"
                            />
                        </FormField>
                        <p className="text-sm text-primary-300">
                            No website list or separate browser approval is needed. You
                            can stop access at any time.
                        </p>
                        <ActionGroup>
                            <Button
                                type="submit"
                                busy={request.isPending}
                                disabled={!ready}
                            >
                                Start browser
                            </Button>
                        </ActionGroup>
                    </form>
                )}
                {request.error && <ErrorNotice error={request.error} />}
                {stop.error && <ErrorNotice error={stop.error} />}
            </div>
        </Modal>
    );
}
