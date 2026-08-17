---
"@mcpjam/inspector": minor
---

Give User Testing one create flow, and let a scenario's setup be edited without Project Environments.

Flag-off, `/user-testing/new` rendered a separate form that offered a single-select Server dropdown and wrote `serverIds: [serverId]`. A tester could reach exactly one MCP server, and nothing could change that afterwards: the scenario's backing client is tagged `owner: 'user_testing'`, which `isPrivateScenarioBackingHost` hides from every client list and picker, and the "Edit setup" affordance on the scenario page was gated on `project-environments-enabled`. A scenario created in that state was frozen at one server for the rest of its life.

Nothing needed to be built for this. `EnvironmentComposer` gates only its saved-environment picker on the flag — the client pill and `ServerGroupPicker` render either way, which is what a flag-off project has always seen in the Swarms create flow. So `/user-testing/new` now uses that composer in both flag states: flag-off it asks for a client and an optional server group and resolves them to an ad-hoc environment, which reaches a whole server group instead of one server. The single-server form and its test are deleted rather than kept as a fallback.

Composing needs the backend's `ensureAdhocEnvironments`, and that is not a new requirement flag-off. The deleted flow's only write was `hosts.createHost({owner: 'user_testing'})`, which has called `ensureOneAdhocEnvironment` internally since scenarios became environment-backed, and the client-callable mutation shipped before that. Any deployment that could serve the old flow can serve this one, which is why there is no legacy resolution path.

"Edit setup" now appears for any environment-backed scenario, flag or no flag — the flag-off scenario is precisely the one that had no other way to change its servers. Promotion stays gated: "Save as environment" would name a row into a list the user has no page for.

The scenario name now defaults to the picked client's name when a setup is composed, the way it defaults to the environment's label when one is picked. Without it a flag-off user picked a client and met a required field nothing filled — the deleted flow defaulted the name off the client template for the same reason.
