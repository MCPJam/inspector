---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Tier B Phase 3d-ii (value relocation): move the pure `extractMethod` +
`stableStringifyJson` helpers into `@mcpjam/sdk/widget-runtime` so the
(relocating) widget renderer and the inspector share one framework-free impl
instead of duplicating it across the package boundary.

The inspector's `@/stores/traffic-log-store` and `@/lib/client-config` now import
the helpers from the SDK and re-export them for back-compat, so every existing
import site is unchanged. No behavior change.
