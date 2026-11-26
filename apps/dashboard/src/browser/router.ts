import {
    createRootRoute,
    createRoute,
    createRouter,
    redirect,
    type RouterHistory,
} from "@tanstack/react-router";
import * as v from "valibot";

import { incidentLocation } from "./features/alerts/incidentLocation";
import { calendarLocation } from "./features/calendar/calendarLocation";
import { jobLocation } from "./features/jobs/jobLocation";
import { restartLocation } from "./features/maintenance/restartLocation";
import { ReportFromLocation } from "./features/mira/ReportFromLocation";
import { Shell } from "./layout/Shell";
import { Alerts } from "./pages/Alerts";
import { Backups } from "./pages/Backups";
import { Calendar } from "./pages/Calendar";
import { Identity } from "./pages/Identity";
import { Infrastructure } from "./pages/Infrastructure";
import { Jobs } from "./pages/Jobs";
import { Mira } from "./pages/Mira";
import { MiraAutomations } from "./pages/MiraAutomations";
import { NotFound } from "./pages/NotFound";
import { Overview } from "./pages/Overview";
import { Reports } from "./pages/Reports";
import { RouteError } from "./pages/RouteError";
import { Settings } from "./pages/Settings";
import { Tasks } from "./pages/Tasks";
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
    const reports = createRoute({
        getParentRoute: () => root,
        path: "/reports",
        component: Reports,
    });
    return createRouter({
        defaultErrorComponent: RouteError,
        routeTree: root.addChildren([
            createRoute({ getParentRoute: () => root, path: "/mira", component: Mira }),
            createRoute({
                getParentRoute: () => root,
                path: "/calendar",
                validateSearch: (raw) => v.parse(calendarLocation, raw),
                component: Calendar,
            }),
            createRoute({ getParentRoute: () => root, path: "/tasks", component: Tasks }),
            reports.addChildren([
                createRoute({
                    getParentRoute: () => reports,
                    path: "$reportId",
                    component: ReportFromLocation,
                }),
            ]),
            createRoute({
                getParentRoute: () => root,
                path: "/mira-automations",
                component: MiraAutomations,
            }),
            createRoute({
                getParentRoute: () => root,
                path: "/mira/$conversationId",
                validateSearch: (raw): { settings?: boolean } =>
                    raw.settings === true ? { settings: true } : {},
                component: Mira,
            }),
            createRoute({
                getParentRoute: () => root,
                path: "/alerts",
                validateSearch: (raw) => v.parse(incidentLocation, raw),
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
                validateSearch: (raw) => v.parse(restartLocation, raw),
                component: Updates,
            }),
            overview,
            identity,
            infrastructure,
            createRoute({
                getParentRoute: () => root,
                path: "/applications",
                beforeLoad: () =>
                    redirect({
                        to: "/infrastructure",
                        hash: "applications",
                        replace: true,
                        throw: true,
                    }),
            }),
            createRoute({
                getParentRoute: () => root,
                path: "/jobs",
                validateSearch: (raw) => v.parse(jobLocation, raw),
                component: Jobs,
            }),
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
