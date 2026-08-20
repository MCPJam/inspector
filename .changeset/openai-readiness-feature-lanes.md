---
"@mcpjam/sdk": minor
---

Wire the remaining OpenAI lanes: imported MCP skills, plugin UI, migration
leftovers, app-guideline policy, and capability badges.

- **Imported skills** walk `skills/list` pagination rather than reading the first
  page — a server with six skills and a page size of five reports five otherwise,
  under a cap the submission actually exceeds — and hitting the page bound is
  recorded as an incomplete listing rather than treated as the end of it. Each of
  the four size ceilings is checked against the thing it bounds, and listing
  metadata must agree EXACTLY with the frontmatter it points at. The lane is
  dispositive only in `mcp-imported-skills`; elsewhere the absence is a badge.
- **Plugin UI** requires `_meta.ui.domain` to be present AND unique — two
  resources sharing a domain share a sandbox — and grades the CSP allowlist in
  both directions, since a domain allowlisted without being loaded is a hole
  nobody needed and is invisible from watching the template work.
- **Migration** sweeps for the surfaces a Claude bundle may carry that the
  directory does not run, plus `${user_config.*}` placeholders, stdio commands
  and `.mcpb` references. Host-name language stays a heuristic: the word "Claude"
  in a description is not by itself a defect.
- **App guidelines** keep the judgement calls (originality, predictable side
  effects, response minimisation, privacy consistency, advertising) as
  `manual-review` in experience-insights, each naming what a reviewer should look
  at — "a human has to look" with no object is a shrug rather than a task.

Three lane assignments changed while wiring the stages up, each because the
original made a stage permanently undeterminable:

- Advertising moved to experience-insights. Nothing a submission declares says
  whether a plugin shows ads, so as a `required` directory-policy check it could
  only ever be `not-evaluated` — making that lane `incomplete` for every
  submission, and a lane that can never reach `ready` teaches its readers to
  ignore it.
- The promotional-copy rule is graded twice, once over the package's own copy
  (directory-policy) and once over the listing form's (submission-artifacts),
  because those live in different artifacts and only one of them exists before
  someone starts filling in a form.
- The domain-verification token comparison moved to submission-artifacts. The
  token is issued by the portal DURING a submission, so grading it in the
  technical preflight reported every pre-submission run as incomplete on a step
  that cannot have happened yet.
