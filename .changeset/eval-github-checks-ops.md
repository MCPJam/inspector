---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

GitHub Checks — "run this suite on every pull request" — is reachable from agents.

Two new operations, `list_eval_check_repos` and `connect_eval_check_repo`, over
a new org-scoped route family (`GET`/`POST
/v1/organizations/{organizationId}/eval-check-repos`). Not fields on
`update_eval_suite`: a connection binds the organization's GitHub App
installation to a repository, and the suite only decides which suite that
repository answers for — modelling it as a suite setting would have put an
organization-wide write behind a suite id.

The connect goes through `checkRepoConfigsNode:connectVerifiedRepo`, never the
`checkRepoConfigs:connectRepo` mutation beside it, which is marked
`@deprecated COMPATIBILITY ONLY — the unverified connect path` and cannot stamp
an installation id. A test pins that, because nothing else would notice a new
surface growing the unverified pile.

`outagePolicy` is REQUIRED, though the platform leaves it optional: it decides
what a check reports when MCPJam cannot conclude, and a surface that defaults it
is the one that quietly produces repositories nobody chose a policy for — which
an agent would do every time. `outagePolicy: null` on the read is likewise a
real state (nobody chose), not reported as `fail_open`.

The surface is deliberately as narrow as the suite-side section it exposes:
connect, and see what is connected. Retargeting, pausing and disconnecting are
repo-level decisions and stay in Settings → Integrations. `connect_eval_check_repo`
declares `risk: "exposure"`, is gated behind an approval proposal that names the
repository and the policy, and is excluded from the in-app chat toolset with a
written reason.

CLI: `mcpjam eval checks list` and `mcpjam eval checks connect --repo owner/repo
--outage-policy fail-open|fail-closed`.
