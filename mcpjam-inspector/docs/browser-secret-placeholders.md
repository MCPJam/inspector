# `{{secret:NAME}}` — letting a model log in without seeing the password

## The problem

A model with a browser and a credential types the credential. Literally, as a
string, in a tool call. That value then lands in:

- the tool-call **arguments**, persisted verbatim in the transcript;
- the **accessibility tree** that comes straight back, because the renderer
  prints `node.value`;
- the **ledger row**, the eval trace and the swarm stream events;
- and the model's **own context**, where it is re-read on every later step of
  the turn.

So the model has to be *told* the secret in order to use it — the one thing the
materialized-secret machinery avoids everywhere else.

## The shape of the fix

The model writes a placeholder and never learns the value:

```
browser_act { verb: "type", ref: "e7", value: "{{secret:GITHUB_PASSWORD}}" }
```

Four things happen, in this order:

1. **The server plans** (`server/utils/secrets/secret-placeholders.ts`). It
   reads the act, says which names it references, and refuses the ones that
   cannot work — while the page is still untouched.
2. **The value travels beside the command**, as a sibling of it in the
   `POST /v1/commands` body. This is what keeps the ledger row, `/v1/trace` and
   the durable mirror plaintext-free *by construction* rather than by scrubbing:
   no writer is ever handed the value.
3. **The daemon substitutes at the last moment**
   (`daemon/secret-substitution.ts`), immediately before the verb runs, and
   remembers the value for the rest of the boot
   (`daemon/secret-registry.ts`).
4. **What comes back is scrubbed** to the same placeholder — the tree, the page
   text, the DOM signal, a console line the page logged, and the URL after a GET
   submit.

## Turning it on

Off by default for one release:

```
MCPJAM_BROWSER_SECRET_PLACEHOLDERS=1
```

Off, the wording the model reads is byte-identical to the release before this
existed, and no surface can deliver a value whatever it has wired. The flag is
checked *before* any credential is fetched, so a run with it off pays nothing —
not a Convex round trip, not a KMS decrypt.

## What the model is told

Only when the turn actually has at least one materialized secret, two
`browser_act` field descriptions gain a sentence naming the secrets that are
available. **Names only, never values** — a name is one the user chose, is
already visible wherever secrets are configured, and without it the feature is
unusable.

`describeBrowserTools` (the Tools pane, the Raw request preview) deliberately
passes no names, so the host-configuration hash never rotates when a project
adds a secret, and one project's names never appear in a description another
project reads.

## The refusals

Every one of these ends, if unhandled, with a literal `{{secret:NAME}}` typed
into a real field on a real site — reported as a success, and read by the model
as a wrong password.

| Code | When | What the model should do |
| --- | --- | --- |
| `secret_unknown` | No secret by that name is available to this turn | Check the name, and that it is set for this environment |
| `secret_not_typeable` | The name exists but is **brokered**, so its value never enters this process | Ask the user to switch it to materialized delivery |
| `secret_verb_refused` | A placeholder on a verb that types nothing (`click`, `press`, `scroll`, …) | Use `type` or `fill_form` |
| `secret_unsupported_daemon` | The browser is running a build that predates the substitution | Restart the browser session |
| `secret_engine_unsupported` | The browser is the user's own machine | Ask the user to type it themselves |
| `secret_unresolved` | The daemon was sent a placeholder with no value (the planner was bypassed) | Same as `secret_unknown` |

## What it deliberately does not do

- **No escape syntax.** There is no way to type a literal `{{secret:X}}` into a
  page. An escape is a second thing to get right in a security-relevant parser,
  to serve a case nobody has.
- **No screenshot after a substitution.** An act that resolved a placeholder is
  downgraded to `observe: "a11y"`. The scrub is a string replacement and a
  picture is not a string: a site that does not mask the field renders the value
  into the image, where nothing can take it back out.
- **No delivery into a box's environment.** This is a different path from
  `runtimeSecrets` → `secretEnv`, which is what a sandbox's `bash` and a harness
  read. Nothing here becomes an environment variable. See
  `server/utils/secrets/browser-secrets.ts`.
- **No protection against a determined model.** Materialized delivery is
  extractable by design, and this is not the boundary that stops it. What it
  fixes is the model *having to be told* the value in order to use it.

## Surfaces

| Surface | Where it is wired |
| --- | --- |
| Playground chat | `server/routes/web/chat-v2.ts` — reuses the turn's existing `runtimeSecrets` read, never a second one |
| v1 session turn | `server/routes/v1/chat-session-turn.ts` |
| Evals | `server/services/evals-runner.ts` — per iteration, and free while the flag is off |
| User testing / swarms | `server/services/sessionSimulation/runner.ts` |

Brokered names are threaded through `browserBrokeredSecretNames` but no surface
fills them in: listing them costs a second Convex query per turn to improve one
error message, and a caller that passes nothing gets `secret_unknown` instead —
the safe direction.

## The backend gate

Four backend gates refuse to launch or provision an eval or journey run whose
environment selects a materialized secret, because those runs receive none and
would score with the credential silently absent. They now read a capability the
runner declares:

```
browser-materialized-secrets
```

`server/services/evals/runner-capabilities.ts` declares it **only while
`MCPJAM_BROWSER_SECRET_PLACEHOLDERS` is on** — with the flag off,
`resolveBrowserSecrets` returns nothing and every placeholder is refused, so
claiming it would be claiming a delivery this process does not have.

The name is narrower than the refusals' own wording on purpose. It says the
runner can put a materialized secret **into a browser**, and nothing more: the
box's shell and any harness on it still receive none. A run launched under this
declaration can sign into a page and still cannot `curl` with the same
credential. A runner that declares it is accepting that position.

Silence is still a refusal. A runner that declares nothing — every build before
this — is refused exactly as it is today, and so is one that declares `[]` or an
unrelated capability.
