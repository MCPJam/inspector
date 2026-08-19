---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

The suite's computer image is settable, readable, and discoverable from agents.

`environment.computerEnvironment` is now on `PATCH …/eval-suites/{id}` and on
`update_eval_suite`, taking a sandbox-image name or id (`null` clears the pin
and runs fall back to the provider's default base image). It also appears on
the suite detail, reporting the resolved image NAME beside its id so a caller
can echo back what it just set without a second read.

`list_sandbox_images` and `get_sandbox_image` join the MCP catalog. They were
excluded under a "sandbox image lifecycle" rationale that is about builds and
promotions and never fitted two read-only ops — while it stood, an MCP agent
could pin a suite's computer image with no way to enumerate the choices. The
build/promote/use writes stay excluded, and their exclusion strings now say
"lifecycle WRITES" so the distinction survives.

Fixes a data-loss bug in the same write: `updateTestSuite` replaces the
environment envelope wholesale, and the PATCH handler sent `{ servers }`
alone — so editing a suite's server list through the API silently dropped its
server bindings, and would have dropped the new image pin. The handler now
layers onto the suite's current environment, matching what the settings sheet
does.

On the CLI: `mcpjam eval update --computer-image <name-or-id|off>`.
