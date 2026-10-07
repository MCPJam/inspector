---
"@mcpjam/sdk": minor
---

Add Muse (Meta) connector readiness: `gatherMuseReadinessEvidence` and
`gradeMuseReadiness`, a third directory-readiness publisher beside Claude and
OpenAI, graded against Meta's connector guidelines at muse.ai/platform/docs.

Muse adds no MCP extension, so most of its rules are about behaviour. The run
has four lanes and two verdicts. The `technicalStatus` verdict comes from the
wire alone: HTTPS and redirects, a combined read/write tool must not claim to be
read-only, and no credential may appear in a tool listing. The `status` verdict
adds the §5 submission, read from a submission profile with all fields optional.
That covers the overview, contacts, attestations, tool documentation,
integration credentials, the read-only option, the test account, a way to test
without real charges, and a declared Read / Write / Sensitive-write class for
every tool, checked against the server's own annotations. Heuristics for
sensitive writes, writes hidden behind reads, money-movement or trade tools,
and descriptions that steer the agent all go in experience-insights and never
decide either verdict.

Every result carries a suggested classification sheet, and
`formatMuseClassificationSheet` renders it as the Markdown table §5.6 asks
submitters to include in their documentation. The policy corpus is pinned by
hash (`npm run muse-policy:sync` / `muse-policy:check`), with a weekly drift
workflow.
