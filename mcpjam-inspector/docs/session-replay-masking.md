# Session replay: privacy levels, and how to mask a secret

Every browser session runs at one of three **privacy levels**. The level decides
what session replay (PostHog and Sentry Replay) and product analytics may
record. The policy lives in one module, `client/src/lib/session-privacy.ts`,
and both recorders read the same state from it.

Independently of the level, URLs that are credentials (share links, handoff
links, OAuth and sign-in callbacks, secret query keys) are scrubbed from every
telemetry exit and never recorded at all. See [Credential URLs](#credential-urls).
The public summary of this document is `docs/inspector/telemetry-privacy.mdx`
at the repository root.

## The levels

| Level    | Replay records                                                     | Product analytics                                    |
| -------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| `off`    | Nothing. No recorder is constructed.                               | Credentials scrubbed from URLs                       |
| `masked` | PostHog: layout and interaction only (see [Masked profile](#masked-profile)). Sentry Replay: nothing. | Element text and attributes masked; credentials and names scrubbed from URLs |
| `full`   | The page, with inputs and annotated secrets masked                 | Credentials scrubbed from URLs                       |

## Who gets which level

| Session                                                              | Level     |
| -------------------------------------------------------------------- | --------- |
| npx / Docker self-hosted                                             | `off`     |
| `electron-forge start` (dev)                                         | `off`     |
| Any build with `VITE_DISABLE_POSTHOG_LOCAL`                          | `off`     |
| Packaged desktop (Electron), everyone                                | `masked`  |
| Hosted, share link of a published study (the tester chat)            | `masked`  |
| Hosted, signed in, an organization in view has enterprise privacy    | `masked`  |
| Hosted, signed in, organization posture not known within 10 seconds  | `masked`  |
| Hosted, signed in, no organization in view has enterprise privacy    | `full`    |
| Hosted, signed out: visitors, landing pages, guests                  | `full`    |
| Hosted, signed in, organization list still loading                   | `pending` |

`resolveSessionPrivacy` encodes this table, and its tests walk every row.

- **npx/Docker** installs run on someone else's machine against their own MCP
  servers. Recording those sessions is not ours to do, and the volume from every
  OSS install would swamp the quota that makes hosted replay useful.
- **Packaged desktop** records people debugging their own MCP servers on their
  own machines: the npx reasoning, with replay kept for crash debugging.
  Desktop is never `full`.
- **"In view"** means the route's organization, the active one, and the active
  project's. Any one with enterprise privacy is enough.
- **Share links** show a project the viewer may not belong to, so its
  organization's posture cannot be known from this side.
- **Signed-out sessions** carry no organization's data. A guest's sandbox is
  their own, and a guest belongs to no organization that could ask for privacy.

The desktop half of "packaged" needs `import.meta.env.PROD` on top of
`window.isElectron`, because `src/preload.ts` exposes `isElectron: true` in dev
too. Without it, every `electron-forge start` would stream a developer's
renderer DOM into the production projects. `HOSTED_MODE` needs no equivalent:
it comes from `VITE_MCPJAM_HOSTED_MODE`, which only the deployed bundle's config
sets.

## Enterprise privacy

The organization row carries `enterprisePrivacy?: boolean`, and
`organizations:getMyOrganizations` returns it. The client acts only on `true`.

- The backend turns it on when an organization becomes Enterprise.
- Staff can set it explicitly, including an explicit `false`.
- The plan does not decide it, so a downgrade or a renewal gap never changes it.

## Fail closed

- **Nothing records at init.** PostHog starts with
  `disable_session_recording: true`, and Sentry starts without its replay
  integration, on every surface. `useSessionPrivacy` starts them once the level
  is known, with that level's profile. Until then the PostHog profile and the
  autocapture flags are the masked ones.
- **`pending` records nothing.** A signed-in hosted session waits for its
  organization list. The cost is roughly the first second of each page load.
- **An answer that never comes is `masked`.** If the level is still `pending`
  after 10 seconds (`PRIVACY_PENDING_TIMEOUT_MS`), the session records `masked`.
  It never falls back to `full`.

## Changing level mid-session

Switching organizations can change the level.

**`full` → `masked`** is applied in a layout effect, in the same React commit
that rendered the new organization. That is before rrweb's mutation observer
reports the new DOM.

1. PostHog's recorder stops. Pending mutation records are discarded.
2. The masked profile is set.
3. Recording restarts with a fresh, fully masked snapshot.

posthog-js reads its masking options only when the recorder starts, so stop →
`set_config` → start is the only correct order. `syncSessionRecording` enforces
it. Nothing recorded after the stop uses the old profile.

**`masked` → `full`** waits 3 seconds (`MASKED_TO_FULL_SETTLE_MS`) and records
masked meanwhile. The previous organization's content can stay on screen for a
moment while the next one loads.

**Sentry Replay** does not record at `masked`. `full` → `masked` stops it in
the same layout effect, before the new organization's DOM is reported;
`masked` → `full` starts it after the same 3-second settle.

## Masked profile

### PostHog replay

`MASKED_SESSION_RECORDING_OPTIONS` and `posthogPrivacyConfig("masked")`:

| Option                                                | Effect                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `maskTextSelector: "*"`                               | Every text node masked. `<style>` text is left alone.           |
| `maskAllInputs: true`                                 | Every input masked                                              |
| `blockSelector`                                       | `img, picture, video, audio, canvas, svg image, iframe, object, embed` replaced by placeholders |
| `captureCanvas: { recordCanvas: false }`              | No canvas frames                                                |
| `maskAttributeFn`                                     | Masks every attribute except an allowlist that layout and styling need (`class`, `style`, `role`, SVG geometry, `aria-expanded` and other state, `data-state` and friends). `maskAllElementAttributes` would also mask `class` and `style`, which leaves a replay of unstyled boxes. |
| `recordHeaders: false`, `recordBody: false`           | No network headers or bodies. A client `false` overrides the project's remote setting. |
| `maskCapturedNetworkRequestFn`                        | posthog-js sends the recorded page URL and every network request through this. Names are scrubbed and headers and bodies dropped. |
| `captureJsonLd: false`, `recordCrossOriginIframes: false` | Off                                                          |
| `enable_recording_console_log: false`                 | No console logs. Wins over the project setting.                 |

### Autocapture

`mask_all_text` and `mask_all_element_attributes` are `true` at `masked` and
`pending`. Both are read per event.

### URLs

Credentials come out of every URL first, at every level (see
[Credential URLs](#credential-urls)). On top of that, `scrubNamesFromUrl`
scrubs names from URLs at `masked` and `pending`:

- In `$current_url`, `$pathname` and the other URL properties
  (`sanitizeAnalyticsProperties`).
- In the `failed_request` attached to `$exception`.
- In the replay page URL.

Route words (read off `APP_ROUTES`) and ids (Convex ids, UUIDs, numbers) stay.
Every other path segment and query value becomes `[name]`, and the fragment is
dropped. For example, `/p/<projectId>/servers/acme-billing?tab=tools` becomes
`/p/<projectId>/servers/[name]?tab=[name]`.

### Sentry Replay

Sentry Replay does not record at `masked` (or `pending`). Its frame-level hooks
cannot keep names out of the rrweb meta event's page URL, and PostHog's masked
profile already covers crash debugging at that level.

At `full`, `SENTRY_REPLAY_OPTIONS` apply:

- `maskAllText`, `maskAllInputs` and `blockAllMedia` are `true`.
- `maskAttributes` adds `alt` and `aria-description` to Sentry's defaults.
- `networkDetailAllowUrls: []` and `networkCaptureBodies: false`: no request or
  response detail for any URL.

## Identity

Identity follows membership, not the organization in view, because person
properties outlive the page.

**PostHog.** A member of any organization with enterprise privacy is identified
by id only. `usePostHogIdentify` sends name, email and occupation only once the
organization list has loaded and shows no such membership. When it does show
one, the hook calls `unsetPersonProperties` once per load to clear values sent
earlier.

**Sentry.** Everyone is identified by id alone (`setSentryActor`): no email, no
name, member or not, so no membership signal is needed.

Desktop identity is unchanged for everyone else.

## Credential URLs

Some URLs are bearer credentials: the token in `/results/<token>` is the only
access control on a run, an OAuth callback's `?code=` is a one-time
authorization code, `?_token=` is a session. Every telemetry sink sees URLs, so
every sink has to agree on what a credential URL is. They read one registry.

### The registry

`shared/credential-urls.ts` defines:

- **`CREDENTIAL_ROUTES`**: every route whose path, query or fragment carries a
  secret, with an `id`, a `pattern` (`/results/:runToken`, `/oauth/callback*`),
  where the secret sits (`path`, `query`, `fragment`), whether it is a `page`
  or an `api` route, its TTL, and `reserved` values that are app vocabulary
  rather than secrets (`/user-testing/<id>/edit`,
  `/connect/server/request/<id>`). Today: score and bench results, shared
  conformance and eval reports, tester links (and their pre-rename
  `/chatbox/` shape), the server-connection handoff, the MCP OAuth, GitHub App
  and sign-in callbacks, the local access link's `#token=`, the API reads
  behind the share links, the SSE `?_token=`, and signed artifact links' `?t=`.
- **`SECRET_PARAM_KEYS`**: query and fragment keys whose value is a credential
  on any URL, ours or not (`code`, `state`, `token`, `_token`,
  `access_token`, `client_secret`, `signature`, SAML and SSO keys, …), plus
  the families no list can enumerate: presigned `X-Amz-*` / `X-Goog-*` and
  anything ending in `token`, `secret`, `password`, `signature`, `apikey` or
  `credential`. URL userinfo (`https://user:pass@host`) is always stripped.
- **The scrubbers**: `scrubCredentialUrl` (one URL, spelling kept),
  `scrubCredentialsInText` (URLs and credential paths anywhere in free text,
  raw or percent-encoded), and `scrubTelemetryValue` (any JSON-ish value,
  object keys included). The secret becomes `[redacted]`.

The module is pure (no DOM, no Node APIs, no SDK, no lookbehind) so the
browser, the server, Electron main and the relay all import the same code.

### Where each sink applies it

| Sink                         | Where the scrubber runs                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostHog events               | `before_send`, over every property: `$set`/`$set_once`, `$elements_chain` and `$elements`, `$external_click_url`, web vitals, heatmap data (keys included), `$exception_list`. |
| PostHog replay network/URL   | `maskCapturedNetworkRequestFn` at every level: keeps the scrubbed URL and timing only. Headers and bodies are dropped at every level, not just `masked`.             |
| Sentry                       | `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb`. Transaction names are set to the route template (`credentialRouteTemplate`), never the visited path. |
| Server logs (Axiom)          | Every log line and its context, before it is shipped.                                                                                                              |
| `/relay` (PostHog proxy)     | Decodes each event payload, rewrites it through `scrubTelemetryEvent`, and re-encodes it. Strips `Referer`.                                                        |

### Replay is blocked, not scrubbed

A recorder snapshots the address bar, the DOM that renders the secret and the
requests that send it. Scrubbing that afterwards is not a guarantee; not
recording is. `isReplayBlockedLocation` is true for a registered credential
path, a callback route, and any URL with a secret query or fragment key
(including one nested in another parameter's value). Neither recorder records
there, at any level.

- **Hard load.** Neither recorder is started on a blocked URL. When the user
  leaves it, recording starts at the session's level. Sentry's integration is
  constructed then too: starting it earlier and stopping it would flush the
  token-bearing page.
- **In-app navigation.** `useSessionRecordingPathGuard` stops both recorders
  **before** the navigation onto a blocked URL commits, and resumes them on
  exit.
  - PostHog resumes with `startSessionRecording()` without an override, which
    still honours the project's sampling.
  - Sentry resumes only a replay the guard itself stopped, because Sentry's
    `replay.start()` bypasses `replaysSessionSampleRate`. Its armed flag is
    never cleared on the way in, so `/results/a` → `/results/b` does not forget
    that the guard is what stopped the replay.

### Out of the address bar early

- The OAuth callback inbox removes `code` and `state` from the address bar
  before telemetry starts.
- A failed share-link redeem, or a refused handoff claim, drops the token from
  the address bar.
- Credential pages are served with `Referrer-Policy: no-referrer`.

### Fail closed on credentials

A payload that cannot be shown clean is dropped, never forwarded:

- `scrubTelemetryEvent` never throws. If the walker cannot finish (a cycle,
  more than 64 levels, more than 200,000 nodes) it deletes the URL-bearing
  fields (`URL_BEARING_FIELDS`) and scrubs the rest; if that fails too it
  returns `null` and the caller drops the event.
- The relay drops what it cannot read: oversized, malformed, or in an
  encoding it does not decode. It does not forward the original instead.
- A replay batch that contains a credential is accepted and dropped: the relay
  answers 200 so posthog-js does not retry it.

### Completeness in CI

`client/src/lib/__tests__/credential-route-completeness.test.ts` and
`server/routes/web/__tests__/credential-route-completeness.test.ts` walk every
client route and every server route. A parameter whose name looks secret
(`/token|secret|code|key|sig|cred/i`) fails the build unless it is in
`CREDENTIAL_ROUTES` or allow-listed with a reason.

`shared/__tests__/credential-leak-monitor.test.ts` checks the production leak
monitor (`ops/credential-leak-monitor/`) against the same registry: every
route has a pattern that catches its unredacted URL and misses its
`[redacted]` form.

### Production monitor

`.github/workflows/credential-leak-monitor.yml` runs daily. It counts PostHog
events and Sentry events from the last 24 hours whose URL properties still
carry an unredacted credential, by registry route id, and posts to the alerts
channel when there are any, or when it could not check. Its patterns are
generated from the registry at run time. Setup and runbook:
`ops/credential-leak-monitor/README.md`.

### Adding a credential route

Add an entry to `CREDENTIAL_ROUTES` (a key that is a credential on any URL goes
in `SECRET_PARAM_KEYS`). The secret must be the template's last parameter.
Nothing else: the scrubbers, both replay guards, the relay and the monitor
all read the registry.

### Old desktop builds

Installed desktop builds keep the code they shipped with. PostHog replay on
those builds is blocked before capture by PostHog's remote URL blocklist
(project settings), which old clients honour. Their events and error reports
are contained after transmission by vendor-side scrubbing rules, and by the
auto-update. We do not claim an old build never sends a credential; the
monitor reports platform and version so those rows are told apart.

## Masking a secret

At `full`, `maskAllInputs: true` covers every `<input>`. It cannot help with
secrets rendered as **text**: OAuth access/refresh tokens in the flow diagram,
the one-time API-key reveal, the SDK quickstart snippet.

There is **one** annotation for those, and it does double duty:

```tsx
<div
  className="ph-no-capture rr-block"
  data-ph-no-capture
>
  {accessToken}
</div>
```

- `data-ph-no-capture` / `.ph-no-capture`: PostHog autocapture skips the
  element's text.
- `.rr-block`: rrweb blocks the node in the recording.
- `maskTextSelector: "[data-ph-no-capture]"`: the same attribute masks the text
  in a `full` replay.

Annotate once, get all three. **Do not** introduce a second attribute for this.
`SECRET_SURFACE_ATTRIBUTE` in `session-privacy.ts` is the single source of
truth, and the selector is asserted in `posthog-utils.test.ts`.

Truncation is not masking: a truncated token prefix is still credential
material. That is why `OAuthFlowProgress`'s token rows carry `sensitive: true`
even though they display `truncateValue(...)`.

## Existing annotated surfaces

- `client/src/components/settings/api-keys/RevealOnceDialog.tsx`: the one-time
  `sk_…` reveal.
- `client/src/components/evals/copyable-code-block.tsx`: the `sensitive` prop.
- `client/src/components/billing/PaymentsHistorySection.tsx`: invoice links.
- `client/src/components/oauth/OAuthFlowProgressSimple.tsx`: the raw
  `JSON.stringify(oauthTokens)` block. This is the one that matters: it is the
  component `AuthTab` actually renders, and it prints the **untruncated** token
  set.
- `client/src/components/oauth/OAuthFlowProgress.tsx`: truncated access and
  refresh token rows (`sensitive: true` on the detail shape).

## Two recorders, one boundary

PostHog is not the only thing that records. **Sentry Replay** captures DOM and
text the same way rrweb does, so it follows the same level:

- `syncSessionRecording` (PostHog) and `syncSentryReplay` (Sentry) both read
  `currentSessionPrivacy()`.
- `useSessionPrivacy` and `useSessionRecordingPathGuard` always call both.
- Sentry's sample rates are set at init only on surfaces that are not `off`.
  Its integration is added lazily, once, at the first moment recording is
  allowed. Zero sample rates alone would still ship the recorder and open its
  buffers.

One asymmetry is deliberate. The PostHog half is skipped when there is no
PostHog client, but the Sentry half always runs. PostHog is routinely
ad-blocked, and bailing out on a missing PostHog client would leave Sentry
recording what the level forbids.

If you change the boundary, change it in `session-privacy.ts` and test both
recorders, or they drift.

## Known gaps

- **Sentry's page URL.** Sentry's rrweb meta event still carries the page URL,
  and Sentry offers no hook to edit rrweb events. It is never a credential URL
  (replay is blocked there) and never a `masked` session (Sentry Replay does
  not record at `masked`), so what remains is names at `full`.
- **Sentry email at boot.** Before the organization list loads, Sentry still
  has the signed-in email.
- **Viewers outside the organization.** The posture of an organization the
  viewer does not belong to is unknown. Share links are `masked` for that
  reason, but a project shared to a non-member outside a share link is judged
  by the viewer's own organizations.
- **Heatmaps.** Credentials are scrubbed from heatmap data, keys included.
  Names in heatmap URLs are not scrubbed at `masked`.
- **Edge request logs.** The hosting provider's edge and CDN keep their own
  request logs. Nothing here runs before them.
- **Content in logs.** Customer content (tool arguments and results, prompts)
  in log lines and error context is a separate content-scrubbing concern; the
  credential registry only covers URLs.
- **Old desktop builds.** See [Old desktop builds](#old-desktop-builds).

## Follow-up: a server-side backstop for the masked level

The `/relay` proxy (`server/routes/relay.ts`) already scrubs credentials from
every event it forwards and drops replay batches that carry one (see
[Fail closed on credentials](#fail-closed-on-credentials)). It does not enforce the `masked` level: a
modified or stale client could still send unmasked replay or name-bearing
URLs. A backstop could:

- refuse or scrub `$snapshot` payloads from sessions that declared `masked`;
- strip name-like URL segments server-side.

Not built yet.

## Cost

Replay sampling is a PostHog project setting: a config change, not a deploy.
Sentry's rates live in `CLIENT_REPLAY_SAMPLE_RATES` (`shared/sentry-config.ts`):
10% of sessions, plus every session with an error.
