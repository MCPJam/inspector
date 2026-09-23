---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Add rubric checks, an advisory second judge for eval suites. Each grading criterion is asked on its own as a yes or no question with a probability, and a suite can add up to ten choice or score questions with a pass line each. Answers show on the trial scorecard under User value, and a criterion near even odds reads Uncertain. They never gate a run. Settings are edited in the app; the public API refuses `settings.judge.rubricChecks`. The SDK's run-disclosure types gain the `rubricChecks` touchpoint and the `typed_decision` rail routing, and `EVALUATOR_STAGE` gains `judge:rubricChecks`.
