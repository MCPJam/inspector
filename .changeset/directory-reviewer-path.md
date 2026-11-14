---
"@mcpjam/sdk": minor
---

Directory readiness checks a submission's reviewer path. Both flows' reviewer sections gain an identity tool, its fixed JSON arguments, the expected reviewer and organization with a JSON path to each, and fixtures (a resource and the read-only tool call that finds it): `reviewer.*` on the ChatGPT flow and `testLaunch.*` on the Claude flow, read with `directoryReviewerStep` and `directoryReviewerSpec`. Three checks report on both directories: `both.reviewer.identity` (verified, wrong account, wrong tenant, or unverified with the reason), `both.reviewer.fixtures` (a missing resource is named with the cases it blocks) and `both.auth.client-signatures` (discovery requested again as a browser and a common HTTP library; a refusal keeps its status and the first 2,000 characters of its body).

`gradeClaudeReadiness` and `gradeOpenAIReadiness` take `reviewerPath` and `clientSignatures`. A check whose placement needs the reviewer runs on the reviewer account only: on a run without one, `holdToReviewerAccount` blocks it with the reason and withdraws any verdict it reached. Reviewer checks with no verdict leave the default gate unless `failOn` names them.
