---
"@mcpjam/sdk": patch
---

A path declared for a suite's grading box is refused when it's longer than 512 characters, as the platform already refuses it. Before, a suite file or settings write with such a path passed the SDK's check and failed on save.
