import { QueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DashboardApp } from "./app";
import { createDashboardRouter } from "./browser/router";

import "./styles.css";

const root = document.querySelector("#root");
if (!root) throw new Error("The application root was not found.");

createRoot(root).render(
    <StrictMode>
        <DashboardApp router={createDashboardRouter()} queryClient={new QueryClient()} />
    </StrictMode>
);
