import {
    createRootRoute,
    createRoute,
    createRouter,
    type RouterHistory,
} from "@tanstack/react-router";

import { Shell } from "./layout/Shell";
import { Alerts } from "./pages/Alerts";
import { Applications } from "./pages/Applications";
import { Backups } from "./pages/Backups";
import { Identity } from "./pages/Identity";
import { Infrastructure } from "./pages/Infrastructure";
import { Jobs } from "./pages/Jobs";
import { NotFound } from "./pages/NotFound";
import { Overview } from "./pages/Overview";
import { RouteError } from "./pages/RouteError";
import { Settings } from "./pages/Settings";
import { Updates } from "./pages/Updates";

/**
 * Build the dashboard route tree with shared layout and error handling.
 * @param history - Optional router history, used for isolated navigation tests.
 * @returns A configured dashboard router.
 */
export function createDashboardRouter(history?: RouterHistory) {
    const root = createRootRoute({
        component: Shell,
        notFoundComponent: NotFound,
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
        defaultErrorComponent: RouteError,
        routeTree: root.addChildren([
            createRoute({
                getParentRoute: () => root,
                path: "/alerts",
                component: Alerts,
            }),
            createRoute({
                getParentRoute: () => root,
                path: "/backups",
                component: Backups,
            }),
            createRoute({
                getParentRoute: () => root,
                path: "/updates",
                component: Updates,
            }),
            overview,
            identity,
            infrastructure,
            createRoute({
                getParentRoute: () => root,
                path: "/applications",
                component: Applications,
            }),
            createRoute({ getParentRoute: () => root, path: "/jobs", component: Jobs }),
            createRoute({
                getParentRoute: () => root,
                path: "/settings",
                component: Settings,
            }),
        ]),
        ...(history ? { history } : {}),
    });
}

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof createDashboardRouter>;
    }
}
