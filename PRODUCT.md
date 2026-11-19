# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Signed-in Homelab operators use Mira for development, administration and everyday work. The Windows app uses the same dashboard interface.

## Product Purpose

Mira carries requested work through to a verified result and makes the current activity understandable. Operators can watch a browser session, take over when needed, and return it to Mira.

## Capabilities and Constraints

The browser must behave like ordinary Chromium: live display, direct mouse and keyboard input, scrolling, tabs and navigation. Websites and development are the primary use; media support is secondary. The operator confirmed that local YubiKey forwarding can follow later.

Reuse the existing authenticated dashboard, dedicated Mira profiles, temporary sessions and explicit stop/return controls. Browser sessions have no fixed wall-clock limit. Code, documentation and interface labels are English. Shared web and Windows behavior remains in the dashboard.

## Product Principles

- Show actual activity and results.
- Keep direct work direct; avoid redundant setup and approval forms.
- Preserve clear operator control and recoverable errors.
- Reuse established components and remove replaced implementation paths.
