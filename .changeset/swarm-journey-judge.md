---
"@mcpjam/inspector": minor
---

Surface and configure the Swarm goal-completion judge.

- The per-session judge badge (`SessionGoalScoreBadge`) moves to the shared `session-quality` module (reusing the eval `ScoreBadge`) and now renders in the Sessions list and run matrix cells; `SwarmJudgeSection` is reachable even for sessions with no transcript.
- The judge config type/defaults are extracted to a shared `GoalJudgeConfig` (evals re-export the historical `EvalJudgeConfig` names), so the eval `JudgesSection` is reusable.
- New journeys expose an **Advanced → Judge** disclosure that reuses `JudgesSection` to set the judge model and auto-grade toggle (`journeys:createJourney` carries the config). Pairs with the backend `judgeConfig` snapshot + config-driven auto-run.
