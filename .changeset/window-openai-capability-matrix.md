---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

### `@mcpjam/sdk`
- **`injectOpenAICompat` per-method capability surface**: new optional `capabilities` field on `injectOpenAICompat(html, widgetData)` controls which `window.openai.*` methods the runtime exposes. Disabled methods are LITERALLY ABSENT on `window.openai` (`typeof window.openai.uploadFile === "undefined"`) so widgets that feature-detect take their fallback path — matching Microsoft 365 Copilot's published subset and OpenAI's recommended detection pattern. `requestDisplayMode` is tri-state (`"all" | "fullscreen-only" | "none"`) and enforced inside the runtime (synchronous return), not at the host. Backwards compatible: callers that don't pass `capabilities` get the full ChatGPT surface they had before.

### `@mcpjam/inspector`
- **Per-method `window.openai` matrix in the Apps tab**: replaces the single "Enable `window.openai`" switch with a per-method matrix matching the OpenAI Apps SDK / Microsoft 365 Copilot Component-bridge table. Preset chips — "Match ChatGPT", "Match Copilot", "Match host preset" — set the override block to a well-known shape; the inspector now ships `OPENAI_APPS_FULL_SURFACE` and `OPENAI_APPS_COPILOT_SURFACE` constants. `selectFiles` / `setOpenInAppUrl` are typed for forward compatibility but flagged "Not implemented in Inspector" until the runtime wires them.
- **Capability changes invalidate the iframe reload key**: switching host styles from ChatGPT (full) to Copilot (subset) mid-session, or flipping a single method in the matrix, now refetches the widget HTML — the previous reload key only tracked injection on/off and would leave stale bytes in the iframe.
- **Persisted replay provenance**: eval traces and saved views now record `injectedOpenAiCompatCapabilities` next to `injectedOpenAiCompat`, so replay/debug can answer "which surface was injected", not just "shim: yes/no". Legacy records (boolean only) replay against the full ChatGPT surface — matches the runtime default at capture time.
- **Defense-in-depth host-side gates** on `openai:uploadFile` / `openai:getFileDownloadUrl` / `openai:setWidgetState` / `openai/requestModal` / `openai/requestClose` / `openai/requestCheckout` messages. The primary contract is "method absent on `window.openai`"; these gates only fire if a widget captured a stale method reference or hand-crafted the postMessage.
