---
"@mcpjam/sdk": minor
---

Four platform operations work on the eval suite that holds a directory submission's test cases. `getDirectorySubmissionEvalsOperation` reads the linked suite and run with each case's result; `setDirectorySubmissionEvalsOperation` links or unlinks them, reading the current revision when none is given and deriving a replay key from the change; `importDirectorySubmissionTestCasesOperation` imports a ChatGPT plugin package's review test cases into the suite; and `exportDirectorySubmissionTestCasesOperation` returns the cases in the shape ChatGPT's form takes. The `directory-readiness` feature gates the link and the import; the reads stay open. They follow the test plan operations in `ALL_OPERATIONS`.
