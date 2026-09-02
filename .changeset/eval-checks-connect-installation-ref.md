---
"@mcpjam/inspector": patch
---

Connecting a GitHub Checks repository works from the CLI and MCP again

`POST /v1/organizations/:organizationId/eval-check-repos` refused every connect
with "Repository is not accessible to the MCPJam GitHub App." — while the GET on
the same route listed that exact repository as `connectable` one request
earlier. Two commands, one truth, and they disagreed.

`connectVerifiedRepo` reads an ABSENT `installationRef` not as "pick one for me"
but as a selector: it means the pinned compatibility branch, which resolves the
deployment-level `GITHUB_CHECKS_INSTALLATION_ID` env var. That var is a
deliberately retired migration pin and is unset in production, so the branch
resolved nothing and refused. The web picker never landed there — it sends the
reference and the numeric repository id it read out of the repository listing.
Every agent surface did, because it has no picker to read.

The POST now resolves the name against the same `listInstallationRepos` the GET
exposes, and sends the `installationRef` and `repositoryId` that listing carries.
Matching is on trim + lowercase, the spelling the backend stores and looks a row
up under, so a correctly-typed `Acme/Widgets` is no longer refused. A repository
the listing does not hold is refused with the route's existing flat sentence and
no candidate names — a repository that does not exist and one the App cannot see
have to read identically, or the endpoint becomes an oracle for private
repository names. A name that matches two entries is refused rather than
resolved by guessing: the backend deduplicates its fan-out by numeric repository
id, not by name, so one name across two bindings is a real shape.

A failed listing now fails the request instead of falling through. Continuing
without a reference would have taken the retired branch and produced that same
"not accessible" refusal for what is actually a GitHub blip — sending an admin
off to re-install an App that is installed fine. The backend's own "Could not
list repositories from GitHub." keeps its wording, and with it the advice to
retry.
