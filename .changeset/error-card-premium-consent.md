---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Error surface: classify the OAuth consent state, and restyle the error card.

A server that needs OAuth consent rendered as "Unknown error" with the advice to file an issue. The client's OAuth orchestrator returned a hand-written sentence for its `reauth_required` result, the server-state hook dispatched that bare string, and the describer matched nothing in it, so an expected one-click state fell into the `internal/unknown` bucket and displayed copy written for MCPJam engineers.

The SDK gains an `auth/consent_required` catalog entry, at `warning` severity with a `user_config` origin, plus a message fallback matching MCPJam's own consent and reauthenticate wording so strings already persisted in client state classify too. The orchestrator now attaches the typed block to `reauth_required` and the hook forwards it through the connect-failure dispatch, so a live consent state never depends on the wording at all. The server card offers a Reconnect button for it.

`ErrorCard` is restyled across all of its call sites. Severity is carried by one accent — the icon and a hairline left rule — over a neutral surface, replacing the filled colour panel. The collapsed face keeps the title, the one-line explanation, the fix, and Copy; "Learn more" moves into the details panel with the rest of the evidence. Inside that panel a single likely cause renders as a sentence rather than a one-item bullet, the raw-error row is dropped when it only repeats the headline, a raw code shows as a chip, and long raw text wraps on word boundaries instead of mid-word. For `internal/unknown` only, the catalog's developer-facing causes and next steps are suppressed and the title reads "Connection error" whenever raw text is present.

The server connection card drops the red "Error" pill, which was the fourth red element announcing one failure and only toggled a disclosure the card already owns. "Failed (0)" now reads "Failed" until something has actually been retried, the OAuth step-failure line is no longer red, and the generic "Check troubleshooting" footer is hidden when an error card is present, since that card carries a docs link aimed at the specific error.
