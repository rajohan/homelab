import { IdentityClient } from "@homelab/identity-ui/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AuthScreen } from "./AuthScreen";

import "../styles.css";

const root = document.querySelector("#root");
if (!root) throw new Error("The identity application root was not found.");
const address = new URL(globalThis.location.href);
const token = new URLSearchParams(address.hash.slice(1)).get("token");
if (address.hash)
    globalThis.history.replaceState(null, "", `${address.pathname}${address.search}`);

createRoot(root).render(
    <StrictMode>
        <QueryClientProvider client={new QueryClient()}>
            <AuthScreen client={new IdentityClient()} address={address} token={token} />
        </QueryClientProvider>
    </StrictMode>
);
