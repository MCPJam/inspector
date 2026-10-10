# Session replay: privacy levels, and how to mask a secret

Every browser session runs at one of three **privacy levels**. The level decides
what session replay (PostHog and Sentry Replay) and product analytics may
record. The policy lives in one module, `client/src/lib/session-privacy.ts`,
and both recorders read the same state from it.

Enterprise replay is **always masked**. It is viewable only by the MCPJam
engineers and support staff who are named on the vendor projects (see
[Access](#access-and-acceptance)). No debugging permission unmasks a replay.

Three layers enforce the same policy:

1. **The backend decides.** `telemetryPrivacy:getContext` (mcpjam-backend)
   resolves the contexts in view, through the viewer's own project and
   organization access, to two values: `recording` (`full` | `masked`) and
   `identity` (`full` | `id_only`). Anything it cannot verify is masked, and
   a private context in view or membership of a private organization makes
   both restrictive.
2. **The client applies it** to both recorders, to identify calls, and to
   every event it captures (this document).
3. **The relay enforces it again** for everything PostHog receives through
   MCPJam (`server/routes/relay.ts`, [below](#the-relay-backstop)). A client
   that gets it wrong, an old client, or a forged one cannot upload an
   unmasked replay through it.

## The levels

| Level    | Replay records                                                     | Product analytics                                    |
| -------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| `off`    | Nothing. No recorder is constructed.                               | Unchanged                                            |
| `masked` | Layout and interaction only (see [Masked profile](#masked-profile)) | Element text and attributes masked; names scrubbed from URLs |
| `full`   | The page, with inputs and annotated secrets masked                 | Unchanged                                            |

## Who gets which level

| Session                                                                       | Level     |
| ----------------------------------------------------------------------------- | --------- |
| npx / Docker self-hosted                                                      | `off`     |
| `electron-forge start` (dev)                                                  | `off`     |
| Any build with `VITE_DISABLE_POSTHOG_LOCAL`                                   | `off`     |
| Packaged desktop (Electron), everyone                                         | `masked`  |
| Hosted, share link of a published study (the tester chat)                     | `masked`  |
| Hosted, the backend answered `masked` for the contexts in view                | `masked`  |
| Hosted, no context in view, or no session to verify one with                  | `masked`  |
| Hosted, no answer within 10 seconds                                           | `masked`  |
| Hosted, every context in view verified non-private, viewer in no private org  | `full`    |
| Hosted, waiting for the first answer                                          | `pending` |

`resolveSessionPrivacy` encodes this table, and its tests walk every row.
**Full replay requires a verified non-private context.** A visitor with no
session, a page with nothing in view, and a context the viewer cannot reach
all get `masked`. So does every page for a member of a private organization:
the shell renders that organization's name and projects wherever they are.

- **npx/Docker** installs run on someone else's machine against their own MCP
  servers. Recording those sessions is not ours to do, and the volume from every
  OSS install would swamp the quota that makes hosted replay useful.
- **Packaged desktop** records people debugging their own MCP servers on their
  own machines: the npx reasoning, with replay kept for crash debugging.
  Desktop is never `full`.
- **"In view"** means the route's organization, the active one, and the active
  project. The backend resolves the project to its owning organization, so an
  outside collaborator (a `guest` member with a project grant) is judged by
  the project's organization, not their own. The most restrictive context
  wins.
- **Share links** show a project the viewer may not belong to, so its
  organization's posture cannot be known from this side.
- **Guests** are authenticated with a guest token and their own personal
  organization is in view, so their sandbox resolves like anyone's.

The desktop half of "packaged" needs `import.meta.env.PROD` on top of
`window.isElectron`, because `src/preload.ts` exposes `isElectron: true` in dev
too. Without it, every `electron-forge start` would stream a developer's
renderer DOM into the production projects. `HOSTED_MODE` needs no equivalent:
it comes from `VITE_MCPJAM_HOSTED_MODE`, which only the deployed bundle's config
sets.

## Enterprise privacy

The organization row carries `enterprisePrivacy?: boolean`. Only `true`
counts.

- The backend turns it on when an organization becomes Enterprise.
- Staff can set it explicitly, including an explicit `false`.
- The plan does not decide it, so a downgrade or a renewal gap never changes it.

The client no longer reads the flag off its organization list. It asks
`telemetryPrivacy:getContext` (via `useTelemetryPrivacyContext`) with the ids
in view. The query uses the existing access checks (`resolveProjectAccess`,
`getOrgMembership`), returns only the two policy values, and never says which
organization asked for privacy or why a context was refused.

The subscription is keyed on the actor and on the membership set. A change to
either renders once with the query skipped — dropping the previous answer
from Convex's cache — and subscribes again on the next commit, after
`ConvexProviderWithAuth` has handed Convex the new token. An answer computed
for a previous actor is therefore never read as the current actor's.

## Fail closed

- **Nothing records at init.** PostHog starts with
  `disable_session_recording: true`, and Sentry starts without its replay
  integration, on every surface. `useSessionPrivacy` starts them once the level
  is known, with that level's profile. Until then the PostHog profile and the
  autocapture flags are the masked ones.
- **`pending` records nothing at startup.** A hosted session waits for the
  backend's first answer. The cost is roughly the first second of each page
  load.
- **An answer that never comes is `masked`.** If the level is still `pending`
  after 10 seconds (`PRIVACY_PENDING_TIMEOUT_MS`), the session records `masked`.
  It never falls back to `full`.

## Changing level mid-session

Navigating to another organization or project changes the contexts in view,
and the backend has to answer for the new ones.

**Navigation** (`full` → `pending`) records `masked` at once, rather than
stopping: the destination is unknown, so it is treated as private.

**`full` → `masked`** is applied in a layout effect, in the same React commit
that rendered the new organization. That is before rrweb's mutation observer
reports the new DOM.

1. PostHog's recorder stops. Pending mutation records are discarded.
2. The masked profile is set.
3. Recording restarts with a fresh, fully masked snapshot.

posthog-js reads its masking options only when the recorder starts, so stop →
`set_config` → start is the only correct order. `syncSessionRecording` enforces
it. Nothing recorded after the stop uses the old profile.

**`masked` → `full`** needs the destination to have resolved to `full` AND
finished loading (`contextReady`: Convex auth, the organization list and the
project's server config). Then it still waits 3 seconds
(`MASKED_TO_FULL_SETTLE_MS`), recording masked meanwhile. The previous
organization's content can stay on screen for a moment while the next one
loads.

**Sentry Replay** needs no restart. Its options mask at both levels, and the
masked-only extras are applied frame by frame (see below).

## Masked profile

### PostHog replay

`MASKED_SESSION_RECORDING_OPTIONS` and `posthogPrivacyConfig("masked")`:

| Option                                                | Effect                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `maskTextSelector: "*"`                               | Every text node masked. `<style>` text is left alone.           |
| `maskAllInputs: true`                                 | Every input masked                                              |
| `blockSelector`                                       | `img, picture, video, audio, canvas, svg image, iframe, object, embed` replaced by placeholders |
| `captureCanvas: { recordCanvas: false }`              | No canvas frames                                                |
| `maskAttributeFn`                                     | Masks every attribute except an allowlist that layout and styling need (`class`, `style`, `role`, SVG geometry, `aria-expanded` and other state, `data-state` and friends). `maskAllElementAttributes` would also mask `class` and `style`, which leaves a replay of unstyled boxes. A kept `style` has its `url(...)` and URL-like strings scrubbed and its other strings masked (`maskReplayStyle`). |
| `recordHeaders: false`, `recordBody: false`           | No network headers or bodies. A client `false` overrides the project's remote setting. |
| `maskCapturedNetworkRequestFn`                        | posthog-js sends the recorded page URL and every network request through this. Names are scrubbed and headers and bodies dropped. |
| `captureJsonLd: false`, `recordCrossOriginIframes: false` | Off                                                          |
| `enable_recording_console_log: false`                 | No console logs. Wins over the project setting.                 |

### Autocapture

`mask_all_text` and `mask_all_element_attributes` are `true` at `masked` and
`pending`. Both are read per event.

### URLs

`scrubNamesFromUrl` (`shared/telemetry-privacy.ts`, used by the client and the
relay alike) scrubs URLs at `masked` and `pending`:

- In `$current_url`, `$pathname` and the other URL properties
  (`sanitizeAnalyticsProperties`).
- In the `failed_request` attached to `$exception`.
- In the replay page URL, and in Sentry breadcrumbs, page URLs, replay events
  and performance spans.

It runs the credential-URL sanitizer (`scrubSensitiveUrl`,
`shared/credential-url.ts`) first, because a share token looks like an id.
Route words (`APP_ROUTE_WORDS`, which a test keeps in step with `APP_ROUTES`),
ids (Convex ids, UUIDs, numbers) and MCPJam's own hosts stay. Every other path
segment and query value becomes `[name]`, every other host `[host]`, and the
fragment and userinfo are dropped. A query key the app's own URLs do not use
becomes `[key]` and its value `[name]` (a key can be the name itself, or a
credential under another name), and a credential value (`code`, `state`,
`token`, `t`, …, in any case) becomes `[redacted]` whatever its shape.
For example, `/p/<projectId>/servers/acme-billing?tab=tools` becomes
`/p/<projectId>/servers/[name]?tab=[name]`.

### Sentry Replay

`SENTRY_REPLAY_OPTIONS` apply at every level:

- `maskAllText`, `maskAllInputs` and `blockAllMedia` are `true`.
- `maskAttributes` masks `title`, `placeholder`, `aria-label`,
  `aria-description`, `alt`, `action`, `formaction` and `poster`.
- `block` covers `a[href]`, `area[href]`, `iframe`, `source`, `track`, and
  any element whose inline `style` holds a `url(`, `image-set(` or a quoted
  string. Sentry's rrweb never passes `href`, `src` or `style` through
  attribute masking (it rewrites their URLs to absolute ones), so the
  elements whose job is a URL, or whose style names one (an MCP server's icon
  drawn as a CSS mask) or carries text (a custom property's label), are kept
  as sized boxes instead. The telemetry browser test caught this.
- `networkDetailAllowUrls: []` and `networkCaptureBodies: false`: no request or
  response detail for any URL.

Short of `full`:

- `beforeAddRecordingEvent` drops console breadcrumbs from the replay and
  scrubs URLs in navigation breadcrumbs and network spans. Click and key
  frames lose the attribute and id parts of their selector
  (`[aria-label="…"]`, `[title="…"]`, `[name="…"]`, `[alt="…"]`, `#…`: an id
  can be built from a name), the node's text-bearing attributes, `id` and
  `testId`, and the names in their page URL.
- `beforeBreadcrumb` (`filterSentryBreadcrumb`) does the same for the
  breadcrumbs error events carry, `ui.click` and `ui.input` selectors
  included, as each breadcrumb is recorded.
- Error events, transactions and replay events lose names from their page
  URL, their `Referer` and their transaction name, which
  `browserTracingIntegration` sets to the raw path on every navigation.
  Transactions also lose resource URLs, peer host names and the attribute
  values inside web-vitals element selectors (`lcp.element`, `cls.source.*`).
- A `preprocessEvent` hook scrubs the replay event's `urls` list.

## Identity

Identity starts **id-only** and follows an explicit grant
(`client/src/lib/telemetry-context.ts`):

- Names and email are allowed only after the backend answers
  `identity: "full"` for the **current actor**. That needs no context in
  view to be private and the actor to belong, in any role, to no
  organization with enterprise privacy. Person properties outlive the page,
  so membership counts even when the organization is not in view. A context
  that does not resolve (stale, deleted, not the actor's) masks recording
  but leaves identity alone, so identity does not flip as the person
  navigates.
- `setTelemetryActor` clears the grant at once on sign-in, sign-out, an
  account change or a new guest. `setTelemetryIdentity` ignores an answer for
  any actor but the current one. A membership reload clears the grant until
  the next answer.
- The identity answer carries across a change of contexts for the same actor
  and memberships, so switching projects does not unname and rename anyone.

**PostHog.** `usePostHogIdentify` sends name, email and occupation only under
the grant. When the answer is `id_only`, it calls `unsetPersonProperties` to
clear values sent earlier: once per actor, and again whenever the actor turns
id-only after a `full` answer. The `before_send` stamp also
strips naming person properties from any event captured while id-only, so a
caller that sends them anyway is caught.

**Sentry.** The initial scope carries at most the desktop installation id.
`setSentryActor` adds email and name only under the grant, and re-applies the
actor whenever the grant changes. Every outbound event — errors, transactions
and replay events, which never reach `beforeSend` — is filtered again in
`postprocessEvent`/`beforeSend` (`filterSentryEventIdentity`). An event keeps
names only if they were allowed both when it was captured and when it is
sent. Existing error processors still run first.

## `/results/<token>` and other credential links

The token in `/results/<token>`, `/conformance/shared/<token>` and
`/evals/shared/<token>` *is* the credential. A replay would capture it in the
DOM snapshot, even though `scrubSensitiveUrl` already keeps it out of event
properties. Neither recorder records on these paths, at any level.

- **Hard load.** Neither recorder is started on the route. When the user leaves
  it, recording starts at the session's level. Sentry's integration is
  constructed then too: starting it earlier and stopping it would flush the
  token-bearing page.
- **In-app navigation.** `useSessionRecordingPathGuard` stops both recorders on
  entry and resumes them on exit.
  - PostHog resumes with `startSessionRecording()` without an override, which
    still honours the project's sampling.
  - Sentry resumes only a replay the guard itself stopped, because Sentry's
    `replay.start()` bypasses `replaysSessionSampleRate`. Its armed flag is
    never cleared on the way in, so `/results/a` → `/results/b` does not forget
    that the guard is what stopped the replay.

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

## Capture context: every event says where it was captured

posthog-js queues events and sends them in batches, so a request can leave
after the person has navigated somewhere laxer. PostHog's `before_send`
(`stampPostHogEvent`) therefore stamps each event, at capture, with
`$mcpjam_telemetry_context`: the project and organizations in view, and the
level and identity mode the client applied. The relay checks the stamp and
removes it. Sentry events get the same treatment through the hint object it
threads through each event's stages.

The relay bearer rides in posthog-js `request_headers` (`usePostHogRelayAuth`),
never in a URL: the signed-in user's WorkOS token or the guest token already
in memory, cleared the moment the actor changes. posthog-js records its whole
config into the replay as a `$posthog_config` custom event, so the stamp and
the relay both strip `request_headers` from it.

## The relay backstop

`/relay` and `/tlm` (`server/routes/relay.ts`, `server/routes/relay-privacy.ts`,
`server/routes/relay-replay-privacy.ts`)
gate every capture request — event batches, replay batches and GET ingestion:

1. Decode the payload once (gzip, base64 form, JSON) and pin it to our
   project, exactly as before. Large payloads are scanned, then parsed one
   event at a time; an event over 8 MiB is refused.
2. Group the events by their capture context and ask the backend
   (`telemetryPrivacy:getContext`) once per distinct context, as the
   request's bearer. An answer is kept for 15 seconds per bearer and
   context: short next to a membership or privacy change, and an honest
   client's own label tightens at once anyway. Each event gets the stricter
   of that answer and its own label. A label can tighten, never authorize
   full capture. An `off` surface (npx, Docker) labels nothing restricted,
   so the backend decides.
3. No bearer (an anonymous visitor, an old client, an unload beacon), no
   stamp, more than eight contexts, or a backend that fails or does not
   answer within 2 seconds: the conservative policy.
4. Restricted events lose naming person properties, `$ip` (and get
   `$geoip_disable`), and autocapture text and attributes. Every property,
   `$set` and `$set_once` included, loses the names in its URLs, paths and
   hosts — whatever it is called, since heatmaps and web vitals switch on
   from PostHog's remote config — and every property named for a name
   (`project_name`, `serverName`) is masked. Query strings keep only the
   app's own keys, and credential values (`code`, `state`, `token`, …) are
   redacted whatever their shape. Their `$snapshot_data` is rebuilt from an
   explicit allowlist of rrweb structures: posthog-js's compressed fields
   (`cv: "2024-10"`, at most 8 MiB each inflated) are inflated, masked and
   re-compressed; text, inputs and non-layout attributes are masked, kept
   `style` values lose their URLs and strings, and stylesheets and CSS rules
   their URLs; media, embeds and fonts are blocked; console, network and
   canvas recordings are dropped. An unknown or undecodable
   structure is refused with a non-retryable `400 unsupported_replay_payload`,
   never forwarded unchanged.
5. The client address is forwarded only when every event in the request
   resolved to the full policy. `Authorization`, privacy-context headers and
   client forwarding headers never reach PostHog. PostHog logs, which carry
   console output that cannot be attributed or masked, are refused.

It reuses the relay's size, decompression, concurrency and rate limits. A
request reads its payload under an admission slot, gives the slot back while
the backend answers (that wait has its own budget: 64 requests, 64 MiB), and
is admitted again to rewrite it, so a slow backend never holds the slots
sized for parsing. GET captures take a slot like any other, and compressed
replay fields count toward the request's admission: a request admitted as
small inflates them only to the floor, and past it takes a large-payload slot
or gets a `503`, which posthog-js retries. The DOM walk yields to the event
loop as it goes. The rewritten payload is forwarded gzip-compressed with
`compression=gzip-js`, as posthog-js sends it. The
aggregate `relay.stats` line counts `privacyMasked`, `privacyRejected` and
`privacyUnresolved` requests; nothing logs payloads, credentials, names or
emails.

Sentry has no ingestion proxy: it is protected by its client capture options
and the outbound filters above.

## Testing

- **Backend:** `tests/convex/telemetryPrivacy.test.ts` in mcpjam-backend.
- **Client:** `session-privacy`, `telemetry-context`, `sentry`,
  `sentry-identity`, `useTelemetryPrivacyContext`, `usePostHogRelayAuth`,
  `usePostHogIdentify` and `useSessionPrivacy` suites.
- **Relay:** `server/routes/__tests__/relay-privacy.test.ts`.
- **Browser:** `npm run test:e2e:telemetry-privacy` (CI job "Telemetry Privacy
  (browser)"). A harness page built from the real telemetry modules shows
  seeded synthetic personal data (`shared/__tests__/fixtures/telemetry-pii.ts`);
  the test intercepts PostHog and Sentry transports, decodes every payload to
  its last compressed field, and asserts that none of it leaves under a
  private context — while a useful layout and interaction recording, and an
  error linked to its replay, do. A `full` run is the positive control.

## Known gaps

- **Sentry's DOM events.** Sentry offers no hook to edit rrweb events, only
  its own frames, so its DOM masking is fixed at init and applies at every
  level. Stylesheets in a Sentry replay (CSS-in-JS rules included) are
  recorded as written; the relay scrubs their URLs for PostHog only.
- **Exception messages.** On restricted PostHog events, URLs inside error
  messages are scrubbed, but other text in error messages and stack traces
  is not; general log sanitization is out of scope here.
- **Restricted replay styling.** Stylesheet URLs (fonts, background images)
  are scrubbed along with everything else, so a restricted replay can fall
  back to default fonts.

## Access and acceptance

- Replay and error data live in the MCPJam PostHog and Sentry projects.
  Access is restricted to named debugging staff, including privileged roles
  and sharing capabilities, and an unauthorized account must not be able to
  view recordings. That is a vendor configuration, verified at rollout.
- The privacy commitment for enterprise organizations is **masked replay
  with restricted staff access**, matching the STI-158 acceptance wording.
  This is a product decision; it does not by itself establish customer
  acceptance of the revised wording.
- A privacy rollback disables the affected replay rather than restoring
  unrestricted forwarding.

## Cost

Replay sampling is a PostHog project setting: a config change, not a deploy.
Sentry's rates live in `CLIENT_REPLAY_SAMPLE_RATES` (`shared/sentry-config.ts`):
10% of sessions, plus every session with an error.
