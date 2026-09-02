---
"@mcpjam/inspector": patch
---

The Cursor CLI harness accepts a BROKERED credential, so it can run in hosted evals and swarms

`harness: "cursor"` could not run in a hosted eval or a swarm in any
configuration. It authenticates on the customer's own Cursor account
(`modelAccess: "external-account"`), and the turn took its `CURSOR_API_KEY`
exclusively from the project's MATERIALIZED secrets — but eval sandboxes and
journey runs REFUSE an environment that selects a materialized secret
(`materialized_secrets_unsupported` / `ENV_MATERIALIZED_SECRETS_UNSUPPORTED`),
because only the chat path resolves and injects those values, so a
runner-claimed attempt would run with the credential silently absent and score a
healthy connector as broken. Configure the secret the turn demanded and the run
was refused at sandbox reservation; leave it out and the turn was refused for a
missing credential.

An external-account credential can now be satisfied by a BROKERED project secret
as well. On that path the plaintext never enters the inspector process or the
sandbox: the backend composes the secret into the box's E2B egress transform,
which overwrites the credential header outside the VM, and the box carries only
a fixed, obviously-fake placeholder so the CLI has something to send. Both
refusals in the backend already say brokered secrets are fine on those surfaces;
this is the inspector half.

Availability is decided at the **environment**, which is the grant boundary the
control plane actually composes a box's egress transform from — not project-wide.
A correctly bound brokered `CURSOR_API_KEY` that the run's environment does not
select is refused up front, naming the selection as the fix, instead of starting a
turn that provisions a box and then fails Cursor's auth against the placeholder.
Chat, swarm and eval launches all carry their environment id down to the harness
turn for this.

Materialized delivery is unchanged and still wins when both are configured — it
is the one this process can prove reached the box. The refusal is still
fail-closed and now names both deliveries and the exact binding a brokered
`CURSOR_API_KEY` needs (`api2.cursor.sh`, `Authorization`, `Bearer {}`), read off
the adapter's own `credentialBrokering` declaration rather than invented. A
brokered row bound to the wrong host is refused by name instead of reaching
Cursor as a placeholder and coming back as an unexplained 401, and a brokered-only
credential on a persistent project Computer is refused too — the control plane
composes brokered secrets onto disposable boxes only.
