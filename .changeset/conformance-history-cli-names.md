---
"@mcpjam/inspector": patch
---

Conformance History and run pages name a CLI, SDK or API run by the URL it ran against instead of a `url:` storage key, and a GitHub run by its repository. When a run can't be saved to History, for example because a plan limit was reached, a message now says so and why; before, the run disappeared without a word.
