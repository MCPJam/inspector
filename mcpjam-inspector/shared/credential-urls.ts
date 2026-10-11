/**
 * Credential URLs: the ONE place that knows which URLs carry a secret, and
 * the one scrubber every telemetry exit applies.
 *
 * Some of our URLs are bearer credentials. The token in `/results/<token>` is
 * the only thing between a private run and anyone holding the link; an OAuth
 * callback's `?code=` is a one-time authorization code; `?_token=` is a
 * session. Every telemetry sink sees URLs — PostHog's `$current_url`, Sentry's
 * transaction names and breadcrumbs, replay meta events, server log lines,
 * the relay's forwarded payloads — so each one has to agree on what a
 * credential URL looks like. They used to keep four lists, and the lists
 * disagreed. Now they read this one.
 *
 * Three things are defined here:
 *
 *  - `CREDENTIAL_ROUTES`: every route whose path, query or fragment carries a
 *    secret, with where the secret sits and how long it lives. CI fails when
 *    a route parameter that looks secret (`/token|secret|code|key|sig|cred/i`)
 *    is not registered here or allow-listed with a reason
 *    (`client/src/lib/__tests__/credential-route-completeness.test.ts` and
 *    `server/routes/web/__tests__/credential-route-completeness.test.ts`).
 *  - `SECRET_PARAM_KEYS`: query/fragment keys whose VALUE is a credential
 *    wherever they appear, on any URL, ours or not.
 *  - The scrubbers: `scrubCredentialUrl` (one URL), `scrubCredentialsInText`
 *    (URLs and credential paths anywhere inside free text), and
 *    `scrubTelemetryValue` (any JSON-ish value, keys included). Every sink
 *    runs the last one.
 *
 * Fail closed: the scrubbers never throw. A URL that cannot be parsed is
 * scrubbed as text; a value the walker cannot finish is reported as a failure
 * so the caller can drop the URL-bearing fields or the whole event
 * (`scrubTelemetryEvent`). Nothing half-scrubbed is ever returned as clean.
 *
 * Pure — no DOM, no Node APIs, no SDK — so the browser, the server, Electron
 * main and the relay all import it. Regexes avoid lookbehind: older Safari
 * fails to PARSE a module that contains one, which would take the app down.
 *
 * The code is in `credential-urls/`: the registry (`registry.ts`), route
 * matching (`matching.ts`), the URL and text scrubbers (`scrub.ts`), replay
 * gating (`replay.ts`) and the fail-closed walker (`walker.ts`). This file is
 * the public API; import from here.
 *
 * `docs/session-replay-masking.md` and the public telemetry-privacy page
 * describe the guarantees this module carries.
 */

export {
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_ROUTES,
  isSecretParamKey,
  SECRET_PARAM_KEYS,
  type CredentialLocation,
  type CredentialRoute,
  type CredentialRouteId,
  type CredentialScope,
  type CredentialTtl,
} from "./credential-urls/registry.ts";
export {
  credentialRoute,
  credentialRouteTemplate,
  escapeRegex,
  matchCredentialPath,
  type CredentialRouteMatch,
} from "./credential-urls/matching.ts";
export {
  containsCredential,
  scrubCredentialsInText,
  scrubCredentialUrl,
} from "./credential-urls/scrub.ts";
export {
  credentialAttributeSelectors,
  isReplayBlockedLocation,
  isReplayBlockedUrl,
  type LocationLike,
} from "./credential-urls/replay.ts";
export {
  POSTHOG_URL_PROPERTIES,
  scrubTelemetryEvent,
  scrubTelemetryValue,
  TelemetryScrubError,
  URL_BEARING_FIELDS,
  type ScrubTelemetryOptions,
} from "./credential-urls/walker.ts";
