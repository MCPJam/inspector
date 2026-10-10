# Session replay: privacy levels, and how to mask a secret

Every browser session runs at one of three **privacy levels**. The level decides
what session replay (PostHog and Sentry Replay) and product analytics may
record. The policy lives in one module, `client/src/lib/session-privacy.ts`,
and both recorders read the same state from it.

## The levels

| Level    | Replay records                                                     | Product analytics                                    |
| -------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| `off`    | Nothing. No recorder is constructed.                               | Unchanged                                            |
| `masked` | Layout and interaction only (see [Masked profile](#masked-profile)) | Element text and attributes masked; names scrubbed from URLs |
| `full`   | The page, with inputs and annotated secrets masked                 | Unchanged                                            |

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
| `maskAttributeFn`                                     | Masks every attribute except an allowlist that layout and styling need (`class`, `style`, `role`, SVG geometry, `aria-expanded` and other state, `data-state` and friends). `maskAllElementAttributes` would also mask `class` and `style`, which leaves a replay of unstyled boxes. |
| `recordHeaders: false`, `recordBody: false`           | No network headers or bodies. A client `false` overrides the project's remote setting. |
| `maskCapturedNetworkRequestFn`                        | posthog-js sends the recorded page URL and every network request through this. Names are scrubbed and headers and bodies dropped. |
| `captureJsonLd: false`, `recordCrossOriginIframes: false` | Off                                                          |
| `enable_recording_console_log: false`                 | No console logs. Wins over the project setting.                 |

### Autocapture

`mask_all_text` and `mask_all_element_attributes` are `true` at `masked` and
`pending`. Both are read per event.

### URLs

`scrubNamesFromUrl` scrubs URLs at `masked` and `pending`:

- In `$current_url`, `$pathname` and the other URL properties
  (`sanitizeAnalyticsProperties`).
- In the `failed_request` attached to `$exception`.
- In the replay page URL.

Route words (read off `APP_ROUTES`) and ids (Convex ids, UUIDs, numbers) stay.
Every other path segment and query value becomes `[name]`, and the fragment is
dropped. For example, `/p/<projectId>/servers/acme-billing?tab=tools` becomes
`/p/<projectId>/servers/[name]?tab=[name]`.

### Sentry Replay

`SENTRY_REPLAY_OPTIONS` apply at every level:

- `maskAllText`, `maskAllInputs` and `blockAllMedia` are `true`.
- `maskAttributes` adds `alt` and `aria-description` to Sentry's defaults.
- `networkDetailAllowUrls: []` and `networkCaptureBodies: false`: no request or
  response detail for any URL.

Short of `full`:

- `beforeAddRecordingEvent` drops console breadcrumbs.
- It also scrubs URLs in navigation breadcrumbs and network spans.
- A `preprocessEvent` hook scrubs the replay event's `urls` list.

## Identity

Identity follows membership, not the organization in view, because person
properties outlive the page.

**PostHog.** A member of any organization with enterprise privacy is identified
by id only. `usePostHogIdentify` sends name, email and occupation only once the
organization list has loaded and shows no such membership. When it does show
one, the hook calls `unsetPersonProperties` once per load to clear values sent
earlier.

**Sentry.** `setSentryIdOnlyIdentity` drops email and name from the user once
membership is known. Before the list loads, a boot crash keeps its attribution.

Desktop identity is unchanged for everyone else.

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

## Known gaps

- **Sentry's page URL.** Sentry's rrweb meta event still carries the page URL.
  Sentry offers no hook to edit rrweb events, only its own frames.
- **Sentry email at boot.** Before the organization list loads, Sentry still
  has the signed-in email.
- **Viewers outside the organization.** The posture of an organization the
  viewer does not belong to is unknown. Share links are `masked` for that
  reason, but a project shared to a non-member outside a share link is judged
  by the viewer's own organizations.
- **Heatmaps.** Heatmap data keyed by URL is not scrubbed.

## Follow-up: a server-side backstop

Everything above runs in the browser. A modified or stale client could still
send unmasked data.

A backstop in the same-origin `/relay` proxy (`server/routes/relay.ts`) could:

- refuse or scrub `$snapshot` payloads from sessions that declared `masked`;
- strip name-like URL segments server-side.

Not built yet.

## Cost

Replay sampling is a PostHog project setting: a config change, not a deploy.
Sentry's rates live in `CLIENT_REPLAY_SAMPLE_RATES` (`shared/sentry-config.ts`):
10% of sessions, plus every session with an error.
