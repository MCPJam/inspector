---
"@mcpjam/inspector": patch
---

Two fixes for the inspector on Windows.

- A local computer command that times out or is cancelled now returns within a few seconds, and the processes it started end, including ones still running after the shell exited. Before, the tool call could hang forever.
- A plugin whose runtime, such as `uvx` or `npx`, is not installed now gets the same "isn't installed on this computer" message as on macOS and Linux, instead of a bare spawn error. Runtimes in quoted `PATH` entries and extensionless scripts are found as the launch itself finds them.
