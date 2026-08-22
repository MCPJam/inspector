---
"@mcpjam/cli": major
---

Share Cloud client construction (`buildCloudClientContext`) and bounded operation running (`runPlatformOperation`) for `projects`, `eval`, `auth`, and `tunnel`. `whoami` now honors `--timeout`. Tunnel sessions still outlive the whole-command deadline.
