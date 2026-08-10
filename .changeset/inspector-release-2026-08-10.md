---
"@mcpjam/inspector": minor
---

Release the latest Inspector updates.

- **User Testing** is rebuilt as a scenario list → detail surface. Create a scenario from a route or by publishing an environment, rename it inline, edit its setup from the header (a pill change rebinds a live share link), and watch the live Preview docked beside Edit. Clusters is now Insights, sharing the Swarms statline, session flow and drill-through chrome.
- **Swarms** gets the run-detail redesign: an insights rail, a statline + Sankey-hero layout with drill-through, rewind-a-branch on edit, and create-flow fixes.
- **Evals** consolidates Evaluate and Runs into one surface under `/evals`, and promoting a tester session into an eval is now the same affordance everywhere.
- **Environments** share one setup composer across Swarms, Evals and User Testing. Ad-hoc setups become unnamed content-addressed rows you can name in place, stdio servers connect on local web-route turns, and resolution declares the venue a run will actually execute in.
- **Computers** gains the local engine: kill switch, engine resolver, consent capability and local bash, a "This machine" face with an engine toggle, per-engine availability from the config endpoint, and cloud-only labelling for swarm/eval/user-testing execution.
- **Plugins** are open to guests, `${PLUGIN_DATA}` is a real writable data directory, a local cache miss falls back to the backend bundle, and a turn's plugins are attributed in one probe call.
- **Integrations** get their own Settings surface (GitHub Checks moved under it), Slack cuts over to the org-level bot, and Discord ships with an org settings page for binding channels to projects.
- The host protocol-version dropdown now offers only versions the selected client actually advertises, so a pin can no longer fail on save.
- Analytics and error reporting: the PostHog relay moves to an edge-safe `/tlm` alias with remote config on the ingest host, replay/surveys/exception extensions and web-vitals are bundled rather than lazy-loaded, events carry deployment and source tags, the anonymous id is forwarded on signup, pageviews are on for caniuse.dev and score.mcpjam.com, and packaged Electron builds report as prod in Sentry.
- Fixes: model picker search drops weak fuzzy matches and empty provider headings; the Playground Tools panel says "no server connected"; OAuth guide steps reveal their descriptions on expansion; spend-precheck denials surface as rate-limited instead of a generic error; the connection detail modal keeps the server name in its header; clearing no longer detaches a server that was still attached; the sidebar footer drops the guest sign-in button; the Organization settings tab stops rebuilding the page; a visitor opening an archived scenario is told so; each surface shows only its own activity; and an ephemeral sandbox is preflighted before provisioning so a failed session can't leave a billable orphan.
