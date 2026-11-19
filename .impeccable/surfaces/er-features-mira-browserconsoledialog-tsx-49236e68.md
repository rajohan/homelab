---
version: 1
slug: "er-features-mira-browserconsoledialog-tsx-49236e68"
primary_target: "apps/dashboard/src/browser/features/mira/BrowserConsoleDialog.tsx"
related_targets: ["apps/dashboard/src/browser/features/mira/BrowserLiveView.tsx"]
---

THESIS
Give the operator a live Chromium window inside the existing Chat browser dialog, with direct pointer, keyboard and scrolling.
OWN-WORLD
Extend Homelab's existing dark product UI, shared Modal and Button components. Preserve the established typography, colors and control hierarchy.
STORY
A browser session appears in Chat. View browser opens a live display. Take control enables native Chromium interaction. Return to Mira visibly hands control back. Stop browser ends the session.
FIRST VIEWPORT
A compact title and controller status, one handover action, Stop browser, and the large live Chromium viewport. File transfer is secondary and collapsed.
FORM
Ordinary extension of the existing application. No world seed. Confirmed operator direction: “det viktigste er nettsider og utvikling” and “Forbedre nettleseren først; YubiKey kan komme senere”.
FINISH
Standard. Verify real Chromium input, native tabs, scrolling, handover, view-only enforcement, disconnect cleanup, narrow-screen layout and current-session authorization. Remove the old page-control and snapshot viewer paths.
