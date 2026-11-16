---
"@mcpjam/cli": minor
---

`mcpjam readiness submission evals show|link|unlink|import|export` works on the eval suite that holds a submission's test cases. `link --suite <id> --run <id>` links the suite and the run that last ran it, at `--expected-revision` or the current revision; `unlink` clears the suite, or with `--run-only` only the run; `import` copies the test cases of the submission's ChatGPT plugin version into the suite; and `export` prints the cases as ChatGPT's form takes them, byte for byte, or saves them with `--out`, naming on stderr any case the form would refuse.
