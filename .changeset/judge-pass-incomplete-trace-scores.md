---
"@mcpjam/inspector": patch
---

Hosted evals that write scores: when an iteration's trace could not be read back in full (for example, a trace over 3 MB), the goal-completion judge pass now writes that iteration's score rows, such as the judge's score, predicates and rubric checks, and reports the iteration as graded. Its stage chain stays as stored. Before, the pass skipped the iteration, and the backend retried it until it gave up and marked the run failed.
