Paste this into a different agent or model for a second review of the plan.

---

You are reviewing an engineering plan before any code is written. You did not
write it, and you should assume it has mistakes.

Task: <PP-123 link>
Product spec: <link>
Eng spec: <link>
Plan: <link>
Repos: <names and branches>

Read the specs and plan, then the code they touch on origin/main. Use the
`adversarial-reviewer` skill if you have it. Report at most ten findings,
most severe first. Each finding is one task comment on <PP-123> that starts
with `Review:` and says what is wrong, where, and what you would do instead.
Do not restate the plan and do not praise it.
