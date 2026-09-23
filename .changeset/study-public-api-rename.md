---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Rename the public `scenario` surface to **study**, and merge its two detail reads into one.

The product has called this object a study since the create flow was rewritten; the API never followed. It does now, while the preview still makes a rename free. Storage is untouched — the Convex table is still `scenarios` and always will be, the way the `hosts` table stayed put when the public noun became `client`.

**Operations.** 22 become 21. `list_scenarios` → `list_studies`, `publish_scenario` / `unpublish_scenario` → `publish_study` / `unpublish_study`, and every `*_user_testing_*` operation drops the prefix for `*_study*`. `get_scenario` and `get_user_testing_scenario` were two generations of one read and collapse into `get_study`, which returns the union: the execution settings the first served, plus the environment id and insights envelope the second added. Those last two depend on the caller, not the study, so a share-link visitor gets the settings without them — absent, never null.

**Routes.** `/projects/{id}/scenarios` and `/projects/{id}/user-testing/scenarios/{scenarioId}` collapse into `/projects/{id}/studies` and `/projects/{id}/studies/{studyId}`; publishing moves to `/environments/{envId}/study`. Responses that named the owning id now say `studyId`.

**SDK.** New `PlatformStudy*` types and `listStudies`…`rebindStudy` client methods.

**CLI.** `cloud scenarios` and `cloud user-testing` merge into `cloud studies`, which answers to both old names. `--study` takes the id; `--scenario` still works and passing both is refused rather than resolved by precedence.

Nothing is removed. Every old operation is still exported and still executable under its old name with its old input and its old DTO, calling its own old route — they are simply absent from the advertised catalog, so no surface can offer one. Every old route still answers, with its original body and a `Deprecation: true` header naming the successor. Both go at general availability.

One behavior change worth calling out: `get_study` is no longer offered to the in-app assistant. `get_scenario` was, because it carried settings and no visitor content; the merged read carries an envelope that quotes real visitors, and the stricter half decides. `list_studies` is unaffected.
