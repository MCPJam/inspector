---
"@mcpjam/inspector": patch
---

A Playground conversation now records the environment it actually ran in

Reopening a Playground conversation could display a completely different host and model than the one it ran on, and a follow-up typed into it would then execute against that unrelated target without ever saying so. The cause was a data gap rather than a rendering bug: **a browser Playground turn never wrote down where it executed.** The direct-chat `resumeConfig` carried seven fields — the system prompt, the temperature, the approval and visibility policies, the tool-result settings, the selected servers — and not one of them was an execution target. With nothing recorded, reopening had nothing to restore from, and the view fell back to whatever the *viewer* happened to have selected in their own browser.

Only sessions created through the v1 agent API wrote that pin. Everything typed into the browser was blind.

The direct-chat turn now writes `resumeConfig.environmentId` — the same field the agent route has always written, already validated, already projected through the ingest allowlist, already served on the session read. No new surface, and nothing to migrate: a conversation that predates the field gets it filled in on its next turn.

**Sent on every turn, not just the first, and that is deliberate.** These resume fields are first-write-wins at the ingest boundary, so a continuation cannot repin a conversation onto a different environment — which means re-sending is both harmless and the only way an older session ever gets a value at all. Trying to enforce the pin locally instead would leave every pre-existing conversation unpinned forever.

**A turn with no environment records nothing rather than a placeholder.** An empty pin would read as "we know where this ran, and it was nowhere" — precisely the false certainty that the reopened-conversation disclosure exists to avoid. Absent stays absent, so the disclosure can keep telling the truth.

Host-mode turns still record no target: the resume contract has no key for a host, so that half needs a backend change first and is not attempted here.
