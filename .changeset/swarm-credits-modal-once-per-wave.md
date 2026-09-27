---
"@mcpjam/inspector": patch
---

The "Out of MCPJam credits" dialog now opens only when credits actually ran out, and at most once per swarm.

- **Held credits are not exhausted credits.** When other in-flight requests hold the last credits, the backend refuses with `holds_committed` and says to retry in seconds. A swarm attempt row keeps that refusal's sentence ("MCPJam model limit reached for the moment: … in-flight request(s) hold the remaining credits …") under the generic `user_rate_limit` code, but not the reason, so every surface that read the row called it exhaustion and opened the dialog. The shared check now recognizes the sentence on its own. It matches the backend's exact wording and only a refusal's own message field, so a real exhaustion is still caught when its `details` happen to mention in-flight work.
- **One dialog per wave.** The dialog deduped on the run id, so a 15-run swarm opened it once per run that hit the same wall. Notices now carry the run's `swarmRunGroupId` as well, and the dialog stays closed once either key has been seen. Every key is recorded even when a notice is suppressed, so a run first seen alone and then with its wave still keeps the wave's next run from reopening the dialog.
