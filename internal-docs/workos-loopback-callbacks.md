# WorkOS loopback callbacks for the published Inspector

The npm Inspector uses **production** AuthKit. Changing a local port correctly
changes its `/callback` URL, but it cannot change the WorkOS application's
allowlist. A merged PR or an npm release does not apply these settings.

## Apply the configuration

In the WorkOS **Production** environment, select **MCPJam's Application** and
verify client ID `client_01K4C1TVPBE7JTBFQJF9SDW9P9`. Open Applications → this
application → Redirects. Add only these entries, retaining every existing entry
and the current default:

| Setting       | Add                           |
| ------------- | ----------------------------- |
| Redirect URIs | `http://localhost:*/callback` |
| Redirect URIs | `http://127.0.0.1:*/callback` |
| Sign-out URIs | `http://localhost:*`          |
| Sign-out URIs | `http://127.0.0.1:*`          |

Use the dashboard's Add controls and Save changes. Re-read the list after saving
and verify the existing URLs and default remain. Do not replace the entire list
with only these four values, change client IDs, or broaden host/path wildcards.
The port wildcard is restricted to the two loopback hosts; WorkOS describes it
in its [redirect URI documentation](https://workos.com/docs/sso/redirect-uris).

The development client (`client_01KTN2EWHHJCKRB8RSR307X4SG`) has separate settings.
Changing development does not fix the published package's production login.
This procedure does not change third-party MCP registration strategy or introduce
a callback relay. CLI Connect uses a separate application/callback and needs its
own acceptance test; these `/callback` entries do not cover CLI Connect.

## Verify before releasing

```sh
node .github/scripts/check-workos-loopback.mjs production
# Optional development comparison:
node .github/scripts/check-workos-loopback.mjs development
```

This read-only check requires no credentials, does not complete login, and follows only the one known production authorization-proxy hop. It stops
before fetching AuthKit bootstrap or any local callback. It tests both hosts on 6274, the reported failing port 6276,
7000 and a random high port, plus two lookalike hosts that must stay rejected.
Only a redirect to the selected application's AuthKit `/bootstrap` counts as
admission. HTTP errors, challenges, unexpected origins/paths and timeouts fail
the check. Bootstrap admission is **not** end-to-end sign-in proof.

`release.yml` runs it in preflight for releases shipping the Inspector (including
desktop-only completion), before publishing. The existing explicit `skip_verify`
escape hatch skips this gate as well. Unit tests run in ordinary PR CI; live
production checks are confined to release preflight or the manual command.

After configuration, complete real browser login, refresh, authenticated Convex
requests, and logout with the published Inspector on a non-default port. Retest
concurrent sessions separately. Record the package version and exact origins.

The separate packaged-launcher issue—bare `npx @mcpjam/inspector@latest` exits
when 6274 is occupied—also requires a code fix. Selecting an available port with
`--port` bypasses that startup collision but cannot bypass WorkOS registration.
