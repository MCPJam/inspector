---
"@mcpjam/sdk": minor
---

A Claude connector submission whose authentication answer is "None" has no reviewer account, so the checks that need one (the reviewer identity and fixtures, and the authentication checks a reviewer's sign-in would show) report that they do not apply, with that reason, instead of asking for a reviewer sign-in. `directoryDeclaresNoSignIn(answers)` reads the answer, and `holdToReviewerAccount` takes it as `noSignIn`. Any other answer, and every ChatGPT plugin submission, keeps holding those checks to the reviewer account.
