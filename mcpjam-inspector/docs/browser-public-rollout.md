# Browser rollout: local first, hosted later

Two rollout flags, neither dependent on `computers-enabled`:

| Flag                     | Audience                                                   | Grants                                                                             |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `local-browser-enabled`  | Verified guests and signed-in users in local Node/Electron | Browser on this machine, after explicit Browser consent                            |
| `hosted-browser-enabled` | Signed-in users                                            | Hosted Browser, subject to existing account, entitlement, image, and credit checks |

`webmcp-inspector-enabled` is unchanged. There is no third Browser master flag.
The existing workspace-layout experiment is not required: with it off, Browser
uses the right rail's Browser tab.

## PostHog configuration

Project 212744. Both flags were created **disabled**, with an unconditional 100%
group and evaluation runtime `all`. Do not activate these groups until the smoke
checks below pass. For internal testing, replace the group with a limited cohort
first; include a verified guest distinct ID when testing guest behavior.

- Local: https://us.posthog.com/project/212744/feature_flags/876842
- Hosted: https://us.posthog.com/project/212744/feature_flags/876843

Saved host authoring accepts either rollout; hosted UI only advertises the hosted
rollout. Execution checks the requested location, not the authoring gate. A local
rollout therefore cannot authorize cloud allocation through an eval or journey.
Flags that are missing or unavailable deny access. Inspector evaluates against
the verified WorkOS external ID or guest ID, never a client-supplied flag value.
Local route results are cached for up to ten seconds. Analytics opt-out currently
also prevents this evaluation; do not use an opted-out process for rollout tests.

## Local guest boundary

This uses the existing online guest flow, not a new offline identity system.
The Inspector session/origin guards remain in place; local Browser additionally
requires a loopback Host, a verified member or guest bearer, the local rollout,
runtime readiness, and Browser-only consent. Browser consent does not grant Bash.

Guest projects are namespaced by verified guest identity. Guest HTTP requests
cannot target a member's boot, ledger, frames nonce, or local project profile.
Guest sessions do not call member-only logical-session/profile services. Saving
cloud profiles and cloud allocation remain signed-in operations. An explicit
local request is never changed into a cloud request when denied.

Rollout flags control admission, not immediate termination of existing sockets
or in-flight tool calls. Revoking Browser consent is the device-level stop;
hosted cleanup/hibernate remains available after rollout withdrawal.

## Deployment and release order

1. Merge and deploy backend first with both Browser flags off.
2. Ship Inspector and Electron changes. Leave Computer flags off.
3. Target internal local users and a test guest with the local flag. Keep hosted
   off. Run every local smoke check below on the build that will be released.
4. After those pass, enable local for everyone, including guests. Watch denied
   launches, consent errors, tool suppression, and browser startup failures.
5. Later, validate hosted template, desktop credit rate, data-plane credentials,
   and `HOSTED_BROWSER_TOOLS_ENABLED`. Target internal signed-in users with the
   hosted flag; test provisioning and billing before widening it.

## Required live smoke checks — not completed by unit tests

- Node local, signed in, Computer off: attach Browser, open pane, grant Browser,
  navigate to a harmless test page, and confirm the agent and pane share tabs.
- Repeat through the standard signed-out guest flow. Confirm the chat POST sends
  `browserEngine: local` and the Browser consent header. No cloud reserve occurs.
- Repeat both cases in packaged Electron, including native pane input and reload.
- Guest with absent/stale/revoked consent: cannot launch/control; grant UI recovers.
- Sign out of a member session: the guest does not receive that member's browser.
- Local flag on, hosted off: Cloud is unavailable, Computer stays hidden, and
  direct hosted provisioning/token minting is denied. Browser-only evals and
  journeys cannot allocate a desktop.
- Both flags off: no new Browser launch; stored Browser selections remain
  removable. Existing consent can still be revoked and agent sessions closed.
- Hosted flag on, local off: signed-in cloud launch works with credits metered;
  guests remain denied. No local fallback occurs.

Older installed clients may still hide Browser behind the Computer flag. They
need an application update; this rollout deliberately does not enable Computers
to accommodate them.
