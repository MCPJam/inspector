---
"@mcpjam/inspector": patch
---

Let a repository declare a build/start environment in `mcpjam.yaml`, and inject
it into GitHub PR checks through E2B's `envs` command option.

`checks.env` is a bounded map of `NAME: value` pairs — at most 20 entries, keys
of at most 64 characters matching `^[A-Z][A-Z0-9_]*$`, values of at most 1,024
characters. The bounds mirror the backend's, which already accepts and persists
the field. Anything outside them is **rejected, never truncated or coerced**: a
shortened value, or an unquoted `8080` silently read as `"8080"`, is a different
configuration from the one the author committed, and a check that started a
server with it would report a verdict about something nobody wrote. A value that
is not a string, a map that is a list or a scalar, and an unknown sibling key
under `checks:` all fail the file — which, at an authoritative rung, means the
check fails honestly rather than falling through to a heuristic guess. An empty
`env: {}` normalizes to no environment at all, so it has the same runtime
behaviour and the same wire shape as omitting the field.

**These are non-secret configuration literals. Do not put credentials in
`mcpjam.yaml`.** The map comes out of a file committed to the repository —
readable by anyone who can read the repo — and it is persisted verbatim in
durable backend plan rows. Nothing redacts it and nothing expires it. It is for
the flags a server needs in order to boot, and for nothing that would matter if
it were printed in public. The GitHub-checks clone token is the counter-example
of how a secret is handled here: minted per check, carried on a single
command-line git header, redacted out of every observable failure, and never an
environment variable.

Only an authoritative rung produces one. `mcpjam.yaml` is the only real producer
(the operator override table is empty on purpose), detection never invents an
environment, and the backend refuses `env` on a cacheable `detected` or
`agentic` recipe — so a cached recipe stays env-free. The Inspector reports the
declared map to the plan, and executes back whatever the plan issues: the
backend still owns candidate ordering and selection.

Injection happens at exactly two commands, the build and the background start,
as E2B's `commands.run(..., { envs })` option. Nothing is ever written into a
command string — no `export`, no assignment, no shell interpolation — so the
build and start scripts stay byte-identical with and without an environment, and
author-controlled values never enter a `bash -lc` quoting boundary or the
command text that failure diagnostics quote into a check summary. Provisioning,
clone and fetch, checkout and sha verification, `/proc` listener inspection,
health probes, and the log tail all receive nothing. On a recipe with no
environment the `envs` key is omitted entirely rather than passed as `undefined`
or `{}`.

Error messages name `checks.env` or `checks.env.<key>` and the limit that was
violated. Keys are echoed, because the author needs to see which one is wrong,
and are length-clamped through the same formatter every other echoed key uses.
Values are never echoed.
