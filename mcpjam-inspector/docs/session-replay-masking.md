# Session replay: what gets recorded, and how to mask a secret

## Where replay runs

Recording and PostHog exception capture are enabled on exactly two surfaces:

| Surface                     | Replay | `capture_exceptions` |
| --------------------------- | ------ | -------------------- |
| Hosted (`app.mcpjam.com`)   | yes    | yes                  |
| Packaged desktop (Electron) | yes    | yes                  |
| npx / Docker self-hosted    | no     | no                   |
| `VITE_DISABLE_POSTHOG_LOCAL`| no     | no                   |

The gate is `isErrorCaptureSurface()` in `client/src/lib/PosthogUtils.ts`
(`HOSTED_MODE || window.isElectron`). npx and Docker installs run on someone
else's machine against their own MCP servers — recording those sessions is not
ours to do, and the volume from every OSS install would swamp the quota that
makes hosted replay useful.

Two further carve-outs:

- **`/results/<token>`** is never recorded. The token in that URL *is* the
  credential; a replay would capture it in the DOM snapshot even though
  `scrubSensitiveUrl` already keeps it out of event properties.
- The `VITE_DISABLE_POSTHOG_LOCAL` branch sets `disable_session_recording`
  explicitly. `opt_out_capturing_by_default` suppresses event *sending*, not
  the recorder *loading* — without this, dev builds still fetched
  `/relay/static/recorder.js` on every page load for events they then threw
  away.

## Masking a secret

`maskAllInputs: true` covers every `<input>`. It cannot help with secrets
rendered as **text** — OAuth access/refresh tokens in the flow diagram, the
one-time API-key reveal, the SDK quickstart snippet.

There is **one** annotation for those, and it does double duty:

```tsx
<div
  className="ph-no-capture rr-block"
  data-ph-no-capture
>
  {accessToken}
</div>
```

- `data-ph-no-capture` / `.ph-no-capture` — PostHog autocapture skips the
  element's text.
- `.rr-block` — rrweb blocks the node in the recording.
- `maskTextSelector: "[data-ph-no-capture]"` — the same attribute masks the
  text in replay.

Annotate once, get all three. **Do not** introduce a second attribute for
this; `SECRET_SURFACE_ATTRIBUTE` in `PosthogUtils.ts` is the single source of
truth and the selector is asserted in `posthog-utils.test.ts`.

Truncation is not masking: a truncated token prefix is still credential
material, so `OAuthFlowProgress`'s token rows carry `sensitive: true` even
though they display `truncateValue(...)`.

## Existing annotated surfaces

- `settings/api-keys/RevealOnceDialog.tsx` — the one-time `sk_…` reveal
- `evals/copyable-code-block.tsx` — `sensitive` prop
- `billing/PaymentsHistorySection.tsx` — invoice links
- `oauth/OAuthFlowProgress.tsx` — access + refresh token rows

## Cost

Hosted replay is currently unsampled. Sentry Replay also runs
(`replaysSessionSampleRate: 0.1`, `replaysOnErrorSampleRate: 1.0`). If the two
stack into a real bill, set a replay sampling percentage in PostHog project
settings first — it is a config change, not a deploy.
