---
"@mcpjam/inspector": patch
---

Tidy the Conformance page. It now picks a connected server on its own when nothing usable is selected, starting from the one you last ran there. Protocol versions are listed newest first. Each check shows its message once, in one box: red for a failure that counts, neutral for a skip reason or an unscored finding. Unscored checks get a gray status icon and a tooltip explaining they don't count. The score and report cards have a white background. In run history, a run from the app is labeled UI, the Client-reported tag is gone, and so is the Private button (a shared run keeps its Shareable button so it can be turned off). The Directory Readiness sections are hidden behind the `mcpjam-directory-readiness` flag.
