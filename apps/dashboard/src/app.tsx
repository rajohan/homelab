import type { SystemStatus } from "@homelab/contracts";
import { Badge, Button, Card } from "@homelab/ui";
import { type QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Link, Outlet, RouterProvider } from "@tanstack/react-router";
import {
    ArrowRight,
    Blocks,
    Check,
    LayoutDashboard,
    Server,
    ShieldCheck,
} from "lucide-react";

import { IdentityBoundary } from "./browser/IdentityBoundary";
import type { createDashboardRouter } from "./browser/router";
import { systemStatusQuery } from "./client";

export function Shell() {
    return (
        <div className="grid min-h-screen grid-cols-[250px_minmax(0,1fr)] max-[1050px]:grid-cols-[210px_minmax(0,1fr)] max-[640px]:block">
            <a
                className="absolute -top-20 left-3.75 z-10 rounded-md border border-[#ccdbee] bg-white px-4.5 py-3 focus:top-3"
                href="#main-content"
            >
                Skip to content
            </a>
            <aside className="flex flex-col border-r border-[#e0e6ee] bg-white px-5 pt-8.5 pb-6.25 max-[640px]:border-r-0 max-[640px]:border-b max-[640px]:px-4 max-[640px]:pt-5 max-[640px]:pb-3">
                <Link
                    to="/"
                    className="mx-1.5 mb-10.5 flex items-center gap-2.75 text-[1.2rem] font-bold tracking-[-0.04em] max-[640px]:mx-0 max-[640px]:mb-5"
                    aria-label="Homelab overview"
                >
                    <span className="grid size-10.5 shrink-0 place-items-center rounded-[11px] bg-[#254b8b] text-white">
                        <Blocks size={23} aria-hidden="true" />
                    </span>
                    <span>
                        Homelab
                        <span className="mt-0.75 block text-[0.65rem] font-normal tracking-normal text-[#64738a] max-[1050px]:text-[0.57rem] max-[640px]:text-[0.65rem]">
                            One place. Your infrastructure.
                        </span>
                    </span>
                </Link>
                <nav
                    className="grid gap-1.75 max-[640px]:grid-cols-3 max-[640px]:gap-1.25"
                    aria-label="Main navigation"
                >
                    <Link
                        to="/"
                        activeOptions={{ exact: true }}
                        activeProps={{
                            "aria-current": "page",
                        }}
                        className="flex items-center gap-3 rounded-lg px-3.5 py-3 text-sm font-[550] text-[#526176] hover:bg-[#f1f4f8] aria-[current=page]:bg-[#edf2fc] aria-[current=page]:text-[#234e91] max-[640px]:justify-center max-[640px]:gap-1.5 max-[640px]:px-1.75 max-[640px]:py-2.75 max-[640px]:text-xs"
                    >
                        <LayoutDashboard
                            className="max-[640px]:w-4"
                            size={19}
                            aria-hidden="true"
                        />
                        Overview
                    </Link>
                    <Link
                        to="/settings"
                        activeProps={{
                            "aria-current": "page",
                        }}
                        className="flex items-center gap-3 rounded-lg px-3.5 py-3 text-sm font-[550] text-[#526176] hover:bg-[#f1f4f8] aria-[current=page]:bg-[#edf2fc] aria-[current=page]:text-[#234e91] max-[640px]:justify-center max-[640px]:gap-1.5 max-[640px]:px-1.75 max-[640px]:py-2.75 max-[640px]:text-xs"
                    >
                        <ShieldCheck
                            className="max-[640px]:w-4"
                            size={19}
                            aria-hidden="true"
                        />
                        Settings
                    </Link>
                    <Link
                        to="/infrastructure"
                        activeProps={{
                            "aria-current": "page",
                        }}
                        className="flex items-center gap-3 rounded-lg px-3.5 py-3 text-sm font-[550] text-[#526176] hover:bg-[#f1f4f8] aria-[current=page]:bg-[#edf2fc] aria-[current=page]:text-[#234e91] max-[640px]:justify-center max-[640px]:gap-1.5 max-[640px]:px-1.75 max-[640px]:py-2.75 max-[640px]:text-xs"
                    >
                        <Server
                            className="max-[640px]:w-4"
                            size={19}
                            aria-hidden="true"
                        />
                        Infrastructure
                    </Link>
                </nav>
                <div className="mt-auto px-3.25 pt-10 max-[640px]:hidden">
                    <span className="text-[0.65rem] font-[650] tracking-[0.12em] text-[#68798e] uppercase">
                        Project status
                    </span>
                    <p className="my-1.25 text-[0.925rem] leading-[1.7] font-semibold text-[#33465c]">
                        Identity preview
                    </p>
                    <span className="block text-xs leading-[1.6] text-[#6d7989]">
                        Account security is ready for validation. Infrastructure
                        integrations come next.
                    </span>
                </div>
            </aside>
            <div className="flex min-w-0 flex-col">
                <header className="flex min-h-19.25 items-center justify-between gap-4 border-b border-[#e0e6ee] px-10.5 py-4.5 text-xs text-[#64738a] max-[1050px]:px-6.25 max-[640px]:min-h-15 max-[640px]:px-5 max-[640px]:py-3">
                    <span>Workspace / Homelab</span>
                    <Badge>Identity preview</Badge>
                </header>
                <main
                    className="mx-auto w-full max-w-312.5 flex-1 px-10.5 pt-12.25 pb-15 max-[1050px]:px-6.25 max-[1050px]:py-8 max-[640px]:px-4.5 max-[640px]:py-7.5 min-[1500px]:pt-16.25"
                    id="main-content"
                    tabIndex={-1}
                >
                    <Outlet />
                </main>
                <footer className="px-10.5 pb-6.25 text-[0.7rem] text-[#8490a0] max-[1050px]:px-6.25 max-[640px]:pl-5">
                    Independent services. Shared foundation.
                </footer>
            </div>
        </div>
    );
}

export function ConnectionStatus({
    pending,
    failed,
    data,
    onRetry,
}: {
    pending: boolean;
    failed: boolean;
    data?: SystemStatus | undefined;
    onRetry: () => void;
}) {
    const connectionTone = data ? "positive" : "neutral";
    const connectionLabel = data ? "Connected" : "Checking";
    return (
        <Card aria-labelledby="connection-heading">
            <div className="mb-4.5 flex items-start justify-between gap-3">
                <h2
                    className="text-[1.05rem] leading-[1.45] font-[650] tracking-[-0.015em]"
                    id="connection-heading"
                >
                    Application connection
                </h2>
                <Badge tone={failed ? "warning" : connectionTone}>
                    {failed ? "Unavailable" : connectionLabel}
                </Badge>
            </div>
            <div aria-live="polite">
                {failed && (
                    <>
                        <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                            The dashboard API could not be reached. No infrastructure
                            status can be inferred from this check.
                        </p>
                        <Button className="mt-3.75" onClick={onRetry}>
                            Try again
                        </Button>
                    </>
                )}
                {!failed && pending && (
                    <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                        Checking this application&apos;s API…
                    </p>
                )}
                {!failed && !pending && (
                    <>
                        <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                            The dashboard can reach its own API.
                        </p>
                        <dl className="mt-5 grid gap-2.75 border-t border-[#edf0f4] pt-3.5 text-[0.8rem]">
                            <div className="flex justify-between gap-4">
                                <dt className="text-[#718095]">Service</dt>
                                <dd className="font-mono text-[#33465c]">
                                    {data?.service}
                                </dd>
                            </div>
                            <div className="flex justify-between gap-4">
                                <dt className="text-[#718095]">Phase</dt>
                                <dd className="font-mono text-[#33465c]">
                                    {data?.phase}
                                </dd>
                            </div>
                        </dl>
                    </>
                )}
            </div>
        </Card>
    );
}

export function Overview() {
    const status = useQuery(systemStatusQuery);
    return (
        <>
            <div className="mb-7.25 max-[640px]:mb-5.75">
                <span className="text-[0.65rem] font-[650] tracking-[0.12em] text-[#68798e] uppercase">
                    Overview
                </span>
                <h1 className="mt-2.5 mb-3.25 text-[clamp(1.8rem,3vw,2.5rem)] leading-[1.2] font-[650] tracking-[-0.045em]">
                    A clear home for your homelab.
                </h1>
                <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                    A modular dashboard, starting with a small, independent foundation.
                </p>
            </div>
            <div className="mb-6.25 flex items-start gap-3.25 rounded-[11px] border border-[#ccdbee] bg-[#eef4fd] px-5 py-4.5 text-[#2b538d] max-[640px]:p-4">
                <ShieldCheck className="mt-0.5 shrink-0" size={21} aria-hidden="true" />
                <div>
                    <strong className="text-[0.85rem] font-[650]">
                        Authelia remains in place.
                    </strong>
                    <p className="mt-0.75 text-[0.8rem] leading-[1.7] text-[#496280]">
                        This preview has not replaced authentication or changed access to
                        your services.
                    </p>
                </div>
            </div>
            <div className="grid grid-cols-2 gap-5.5 max-[1050px]:grid-cols-1">
                <ConnectionStatus
                    pending={status.isPending}
                    failed={status.isError}
                    data={status.data}
                    onRetry={() => {
                        void status.refetch();
                    }}
                />
                <Card aria-labelledby="foundation-heading">
                    <div className="mb-4.5 flex items-start justify-between gap-3">
                        <h2
                            className="text-[1.05rem] leading-[1.45] font-[650] tracking-[-0.015em]"
                            id="foundation-heading"
                        >
                            A focused starting point
                        </h2>
                        <Blocks
                            className="shrink-0 text-[#75869b]"
                            size={20}
                            aria-hidden="true"
                        />
                    </div>
                    <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                        Dashboard and identity are separate applications in one workspace.
                        Shared code stays small and explicit.
                    </p>
                    <ul className="mt-5 grid list-none gap-2.75 p-0 text-[0.8rem] text-[#526176]">
                        <li className="flex items-center gap-2.25">
                            <Check
                                className="shrink-0 text-[#548068]"
                                size={17}
                                aria-hidden="true"
                            />
                            Independent application entry points
                        </li>
                        <li className="flex items-center gap-2.25">
                            <Check
                                className="shrink-0 text-[#548068]"
                                size={17}
                                aria-hidden="true"
                            />
                            Typed API and shared UI primitives
                        </li>
                        <li className="flex items-center gap-2.25">
                            <Check
                                className="shrink-0 text-[#548068]"
                                size={17}
                                aria-hidden="true"
                            />
                            No production credentials required
                        </li>
                    </ul>
                </Card>
            </div>
            <Card
                className="mt-5.5 flex items-center justify-between gap-6.25 max-[1050px]:flex-col max-[1050px]:items-start"
                aria-labelledby="next-step-heading"
            >
                <div>
                    <span className="text-[0.65rem] font-[650] tracking-[0.12em] text-[#68798e] uppercase">
                        Next milestone
                    </span>
                    <h2
                        className="my-2 text-[1.05rem] leading-[1.45] font-[650] tracking-[-0.015em]"
                        id="next-step-heading"
                    >
                        Validate identity before cutover.
                    </h2>
                    <p className="max-w-147.5 text-[0.85rem] leading-[1.7] text-[#536174]">
                        Verify real devices and client integrations alongside Authelia
                        before considering a cutover.
                    </p>
                </div>
                <Link
                    to="/identity"
                    className="inline-flex items-center gap-2 text-[0.8rem] font-semibold whitespace-nowrap text-[#2c568f] hover:underline"
                >
                    View the boundary
                    <ArrowRight size={17} aria-hidden="true" />
                </Link>
            </Card>
        </>
    );
}

export function Identity() {
    return (
        <>
            <div className="mb-7.25 max-[640px]:mb-5.75">
                <span className="text-[0.65rem] font-[650] tracking-[0.12em] text-[#68798e] uppercase">
                    Identity
                </span>
                <h1 className="mt-2.5 mb-3.25 text-[clamp(1.8rem,3vw,2.5rem)] leading-[1.2] font-[650] tracking-[-0.045em]">
                    One identity. Clear boundaries.
                </h1>
                <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                    A separate identity application serves the dashboard and other
                    approved clients.
                </p>
            </div>
            <Card aria-labelledby="identity-heading">
                <div className="mb-4.5 flex items-start justify-between gap-3">
                    <h2
                        className="text-[1.05rem] leading-[1.45] font-[650] tracking-[-0.015em]"
                        id="identity-heading"
                    >
                        Independent identity service
                    </h2>
                    <Badge>Identity preview</Badge>
                </div>
                <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                    Authelia continues to handle production sign-ins. The isolated Homelab
                    identity service implements account security, OIDC and ForwardAuth; it
                    has not replaced the existing service.
                </p>
                <ul className="mt-4.5 list-disc pl-5.25 text-[0.925rem] leading-[1.8] text-[#536174]">
                    <li>
                        Review account security in Settings and validate explicit access
                        policies.
                    </li>
                    <li>
                        Verify desktop security keys, mobile NFC, and existing client
                        flows.
                    </li>
                    <li>Keep a tested rollback path before replacing Authelia.</li>
                </ul>
            </Card>
        </>
    );
}

export function Infrastructure() {
    return (
        <>
            <div className="mb-7.25 max-[640px]:mb-5.75">
                <span className="text-[0.65rem] font-[650] tracking-[0.12em] text-[#68798e] uppercase">
                    Infrastructure
                </span>
                <h1 className="mt-2.5 mb-3.25 text-[clamp(1.8rem,3vw,2.5rem)] leading-[1.2] font-[650] tracking-[-0.045em]">
                    Your systems, together.
                </h1>
                <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                    Infrastructure modules will be added after the identity foundation is
                    ready.
                </p>
            </div>
            <Card aria-labelledby="infrastructure-heading">
                <div className="mb-4.5 flex items-start justify-between gap-3">
                    <h2
                        className="text-[1.05rem] leading-[1.45] font-[650] tracking-[-0.015em]"
                        id="infrastructure-heading"
                    >
                        No infrastructure integrations connected
                    </h2>
                    <Badge>Planned</Badge>
                </div>
                <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                    This preview does not query servers, monitoring, backups, or OpenClaw.
                    It displays no synthetic health metrics and exposes no administrative
                    actions.
                </p>
                <p className="mt-3.5 text-[0.925rem] leading-[1.7] text-[#536174]">
                    Future modules will own their API contracts and access permissions
                    without becoming dependencies of the identity service.
                </p>
            </Card>
        </>
    );
}

export function DashboardApp({
    router,
    queryClient,
}: {
    router: ReturnType<typeof createDashboardRouter>;
    queryClient: QueryClient;
}) {
    return (
        <QueryClientProvider client={queryClient}>
            <IdentityBoundary>
                <RouterProvider router={router} />
            </IdentityBoundary>
        </QueryClientProvider>
    );
}

export function NotFound() {
    return (
        <>
            <h1 className="text-[clamp(1.8rem,3vw,2.5rem)] leading-[1.2] font-[650] tracking-[-0.045em]">
                Page not found
            </h1>
            <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                <Link to="/">Return to overview</Link>
            </p>
        </>
    );
}
