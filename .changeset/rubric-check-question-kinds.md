---
"@mcpjam/inspector": patch
---

Suite settings accept yes/no rubric-check questions, and no longer refuse to save a suite whose rubric checks use a question kind this Inspector does not recognize. The server still validates every question on save. Trial scorecards show a yes/no rubric-check question as Uncertain when the grader's P(yes) is between 0.4 and 0.6, as they already do for criteria.
