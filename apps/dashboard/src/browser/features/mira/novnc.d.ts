/// <reference types="novnc__novnc" />

// noVNC 1.7 exports the root; the upstream declarations still use the previous path.
declare module "@novnc/novnc" {
    export { default } from "@novnc/novnc/lib/rfb";
}
