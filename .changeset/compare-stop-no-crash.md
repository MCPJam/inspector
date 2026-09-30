---
"@mcpjam/inspector": patch
---

Stopping a run in the test editor no longer crashes with "undefined is not an object (evaluating '….iteration')". The stopped model's record now waits for React's state update before it is counted.
