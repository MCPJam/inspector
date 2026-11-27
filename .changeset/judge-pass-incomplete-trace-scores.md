---
"@mcpjam/inspector": patch
---

Hosted evals that write scores: whenever the goal-completion judge pass can't derive an iteration's stage chain (for example, the iteration's trace could not be read back in full, or the backend sent the iteration without its authored case), the pass now still writes that iteration's score rows, such as the judge's score, predicates and rubric checks, and reports the iteration as graded. Its stage chain stays as stored. Before, the pass skipped the iteration, and the backend retried it until it gave up and marked the run failed.
