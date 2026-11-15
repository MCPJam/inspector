---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

A directory submission's test cases live in an eval suite, and the API and the platform client now reach it. `getDirectorySubmissionEvals` reads the suite the submission links to, the eval run that last ran its cases, and each case's result in that run: how it was graded (assertions, a judge, both or neither), whether the judge's verdict counts or is advisory, its threshold, and the client that ran it. `setDirectorySubmissionEvals` links or unlinks the suite and the run at the revision you read; a stale revision is refused with `409` naming the current one. `importDirectorySubmissionTestCases` copies the review test cases a ChatGPT plugin package declares into the linked suite, and importing the same version again writes nothing. `exportDirectorySubmissionTestCases` returns the suite's cases as the `successful` and `gracefulFailure` lists of `{prompt, expectation}` that ChatGPT's form takes, as a file whose `content` is its exact bytes; Claude's directory takes no test cases, so a Claude submission is refused.
