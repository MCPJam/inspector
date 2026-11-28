---
"@mcpjam/sdk": minor
---

Adds `get_swarm_run` and `list_swarm_run_sessions`, the reads of one swarm run: the goal runs launched together. `get_swarm_run` returns its state, `settled`, session and grading counts for each goal run and in total, and the launch that started it; `includeLaunchFailures` adds why sessions never ran. `list_swarm_run_sessions` pages the sessions of every goal run in it, oldest first. The client has `getSwarmRun` and `listSwarmRunSessions`. `get_swarms_overview` returns the runs grouped by swarm run as `swarmRuns` when the server reports them, and `list_goal_run_sessions` now says that `get_chat_session` reads a session's transcript.
