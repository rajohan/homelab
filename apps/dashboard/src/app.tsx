import type { SystemStatus } from "@homelab/contracts";
import { Badge, Button, Card } from "@homelab/ui";
import { type QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
    createRootRoute,
    createRoute,
    createRouter,
    Link,
    Outlet,
    RouterProvider,
    type RouterHistory,
} from "@tanstack/react-router";
import {
    ArrowRight,
    Blocks,
    Check,
    LayoutDashboard,
    Server,
    ShieldCheck,
} from "lucide-react";
import { systemStatusQuery } from "./client";

function Shell() {
    return (
        <div className="app-shell">
            <a className="skip-link" href="#main-content">
                Skip to content
            </a>
            <aside className="sidebar">
                <Link to="/" className="brand" aria-label="Homelab overview">
                    <span className="brand-mark">
                        <Blocks size={23} aria-hidden="true" />
                    </span>
                    <span>
                        Homelab
                        <span className="brand-subtitle">
                            One place. Your infrastructure.
                        </span>
                    </span>
                </Link>
                <nav aria-label="Main navigation">
                    <Link
                        to="/"
                        activeOptions={{ exact: true }}
                        activeProps={{
                            className: "nav-link active",
                            "aria-current": "page",
                        }}
                        className="nav-link"
                    >
                        <LayoutDashboard size={19} aria-hidden="true" />
                        Overview
                    </Link>
                    <Link
                        to="/identity"
                        activeProps={{
                            className: "nav-link active",
                            "aria-current": "page",
                        }}
                        className="nav-link"
                    >
                        <ShieldCheck size={19} aria-hidden="true" />
                        Identity
                    </Link>
                    <Link
                        to="/infrastructure"
                        activeProps={{
                            className: "nav-link active",
                            "aria-current": "page",
                        }}
                        className="nav-link"
                    >
                        <Server size={19} aria-hidden="true" />
                        Infrastructure
                    </Link>
                </nav>
                <div className="sidebar-note">
                    <span className="eyebrow">Project status</span>
                    <p>Foundation</p>
                    <span>Authentication and integrations are the next milestones.</span>
                </div>
            </aside>
            <div className="main-column">
                <header className="topbar">
                    <span>Workspace / Homelab</span>
                    <Badge>Foundation preview</Badge>
                </header>
                <main id="main-content" tabIndex={-1}>
                    <Outlet />
                </main>
                <footer>Independent services. Shared foundation.</footer>
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
    return (
        <Card aria-labelledby="connection-heading">
            <div className="card-heading">
                <h2 id="connection-heading">Application connection</h2>
                <Badge tone={failed ? "warning" : data ? "positive" : "neutral"}>
                    {failed ? "Unavailable" : data ? "Connected" : "Checking"}
                </Badge>
            </div>
            <div aria-live="polite">
                {failed ? (
                    <>
                        <p>
                            The dashboard API could not be reached. No infrastructure
                            status can be inferred from this check.
                        </p>
                        <Button onClick={onRetry}>Try again</Button>
                    </>
                ) : pending ? (
                    <p>Checking this application's API…</p>
                ) : (
                    <>
                        <p>The dashboard can reach its own API.</p>
                        <dl className="details">
                            <div>
                                <dt>Service</dt>
                                <dd>{data?.service}</dd>
                            </div>
                            <div>
                                <dt>Phase</dt>
                                <dd>{data?.phase}</dd>
                            </div>
                        </dl>
                    </>
                )}
            </div>
        </Card>
    );
}

function Overview() {
    const status = useQuery(systemStatusQuery);
    return (
        <>
            <div className="page-heading">
                <span className="eyebrow">Overview</span>
                <h1>A clear home for your homelab.</h1>
                <p>A modular dashboard, starting with a small, independent foundation.</p>
            </div>
            <div className="notice">
                <ShieldCheck size={21} aria-hidden="true" />
                <div>
                    <strong>Authelia remains in place.</strong>
                    <p>
                        This preview has not replaced authentication or changed access to
                        your services.
                    </p>
                </div>
            </div>
            <div className="card-grid">
                <ConnectionStatus
                    pending={status.isPending}
                    failed={status.isError}
                    data={status.data}
                    onRetry={() => {
                        void status.refetch();
                    }}
                />
                <Card aria-labelledby="foundation-heading">
                    <div className="card-heading">
                        <h2 id="foundation-heading">A focused starting point</h2>
                        <Blocks size={20} aria-hidden="true" />
                    </div>
                    <p>
                        Dashboard and identity are separate applications in one workspace.
                        Shared code stays small and explicit.
                    </p>
                    <ul className="check-list">
                        <li>
                            <Check size={17} aria-hidden="true" />
                            Independent application entry points
                        </li>
                        <li>
                            <Check size={17} aria-hidden="true" />
                            Typed API and shared UI primitives
                        </li>
                        <li>
                            <Check size={17} aria-hidden="true" />
                            No production credentials required
                        </li>
                    </ul>
                </Card>
            </div>
            <Card className="next-step" aria-labelledby="next-step-heading">
                <div>
                    <span className="eyebrow">Next milestone</span>
                    <h2 id="next-step-heading">Build identity before integrations.</h2>
                    <p>
                        Implement and verify authentication alongside Authelia before
                        considering a cutover.
                    </p>
                </div>
                <Link to="/identity" className="text-link">
                    View the boundary
                    <ArrowRight size={17} aria-hidden="true" />
                </Link>
            </Card>
        </>
    );
}

function Identity() {
    return (
        <>
            <div className="page-heading">
                <span className="eyebrow">Identity</span>
                <h1>One identity. Clear boundaries.</h1>
                <p>
                    A separate identity application will serve the dashboard and other
                    approved clients.
                </p>
            </div>
            <Card aria-labelledby="identity-heading">
                <div className="card-heading">
                    <h2 id="identity-heading">Authentication is not implemented yet</h2>
                    <Badge>Planned</Badge>
                </div>
                <p>
                    Authelia continues to handle existing sign-ins. This application does
                    not accept passwords, issue sessions, or provide OIDC or ForwardAuth
                    endpoints.
                </p>
                <ul className="plain-list">
                    <li>
                        Implement standards-based sign-in and explicit access policies.
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

function Infrastructure() {
    return (
        <>
            <div className="page-heading">
                <span className="eyebrow">Infrastructure</span>
                <h1>Your systems, together.</h1>
                <p>
                    Infrastructure modules will be added after the identity foundation is
                    ready.
                </p>
            </div>
            <Card aria-labelledby="infrastructure-heading">
                <div className="card-heading">
                    <h2 id="infrastructure-heading">
                        No infrastructure integrations connected
                    </h2>
                    <Badge>Planned</Badge>
                </div>
                <p>
                    This preview does not query servers, monitoring, backups, or OpenClaw.
                    It displays no synthetic health metrics and exposes no administrative
                    actions.
                </p>
                <p>
                    Future modules will own their API contracts and access permissions
                    without becoming dependencies of the identity service.
                </p>
            </Card>
        </>
    );
}

export function createDashboardRouter(history?: RouterHistory) {
    const root = createRootRoute({
        component: Shell,
        notFoundComponent: () => (
            <>
                <h1>Page not found</h1>
                <p>
                    <Link to="/">Return to overview</Link>
                </p>
            </>
        ),
    });
    const overview = createRoute({
        getParentRoute: () => root,
        path: "/",
        component: Overview,
    });
    const identity = createRoute({
        getParentRoute: () => root,
        path: "/identity",
        component: Identity,
    });
    const infrastructure = createRoute({
        getParentRoute: () => root,
        path: "/infrastructure",
        component: Infrastructure,
    });
    return createRouter({
        routeTree: root.addChildren([overview, identity, infrastructure]),
        ...(history ? { history } : {}),
    });
}

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof createDashboardRouter>;
    }
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
            <RouterProvider router={router} />
        </QueryClientProvider>
    );
}
