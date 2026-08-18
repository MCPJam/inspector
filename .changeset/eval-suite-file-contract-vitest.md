---
"@mcpjam/vitest": minor
---

Track `@mcpjam/sdk` 5.0, and surface each case's declared id on the plan.

`EvalCasePlan` gains an optional `caseId`, read from `EvalTestConfig.id`, so a CI
reporter can key a case by its identity instead of by a title that gets renamed.
Vitest titles are unchanged: the ` [caseId]` suffix is the handle people grep the
hosted dashboard with and still rides `externalCaseId`, so moving the suffix onto
the declared id would break those greps.

The `@mcpjam/sdk` dependency range is left at `^4.3.0` in the repo on purpose and
must NOT be hand-bumped to `^5.0.0`: the workspace sdk is still 4.x until this
release train runs, and a range no local version satisfies makes npm stop linking
the workspace copy and try to fetch an unpublished 5.x from the registry
(`ETARGET` on `npm ci`). Changesets rewrites the range as part of `changeset
version`, which is what `updateInternalDependencies` is configured for.

`caseId` is read defensively rather than assumed. A consumer can end up with this
package beside an older `@mcpjam/sdk` copy — a mismatched transitive range, a pnpm
layout — where `id` does not exist yet; an absent `caseId` is a missing
convenience, whereas a thrown `TypeError` would be a broken test run. Old
`@mcpjam/sdk` 4.x therefore keeps working at runtime: the wrapper only calls
`getAll` / `getName` / `getConfig` / `run` / `getFailureReport`, all of which
exist in both majors. What such a consumer does NOT get is the compile-time
requirement — their own `EvalTest` constructions are checked by their own SDK
copy, so `id` only becomes mandatory once they upgrade it.
