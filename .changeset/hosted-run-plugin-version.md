---
"@mcpjam/inspector": patch
---

A hosted run of a ChatGPT plugin submission grades a plugin version stored in the project: the run downloads the version's ZIP, checks it against the version's hash, and grades its package beside the saved server. Its report records the version it graded. A version that cannot be downloaded, is too large or does not match fails the run with the reason.
