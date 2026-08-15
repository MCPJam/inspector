---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Set a scenario's name, description and access mode in the same call that publishes it.

Publishing an environment used to take whatever defaults the scenario was created with, so "publish this, but only for invited people" was two operations — a publish, then an update — with a window between them where the share link was live in the DEFAULT mode. Anyone holding the URL during that window got in.

`publishScenario` on the SDK's platform client, and the `publish_scenario` operation behind it, now accept optional `name`, `description` and `mode` (`project_members` | `invited_only` | `anyone_with_link`) and forward them to the v1 route, which applies them at create time. The CLI exposes the same three as `--name`, `--description` and `--mode` on `mcpjam scenarios publish`; a misspelled `--mode` is answered locally as a usage error rather than spending a round trip to learn the flag was typed wrong.

The overrides are CREATE-TIME ONLY. Publishing is idempotent, and re-publishing an already-published environment keeps returning the existing scenario — it does not quietly re-apply the overrides, because that would make a routine re-publish able to change who can open a live link. When overrides were sent and discarded for that reason, the result says `overridesIgnored: true`, and the scenario in the response carries the scenario's REAL name and mode: a caller who asked for `invited_only` must never conclude the link is restricted when it is not. Changing an existing scenario stays `mcpjam user-testing update` / `update_user_testing_scenario`.

Callers that pass no overrides are unaffected — the request body stays empty, exactly what already went on the wire.
