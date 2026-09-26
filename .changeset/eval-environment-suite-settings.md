---
"@mcpjam/inspector": patch
---

Environment suites' settings change their environments.

- The suite settings sheet shows an environment suite's image from its environments (or "different images" when they differ) and saves a change as `environmentSettings`, which the backend carries onto every environment; a clear is sent explicitly.
- `PATCH /v1/.../eval-suites/:id` sends an environment suite's `environment.servers` / `computerEnvironment` as `environmentSettings` on a backend that supports it, instead of the legacy envelope no run reads.
- Launching an environment suite no longer writes the run's servers back into the suite's legacy snapshot, and the legacy "Update snapshot" action is hidden for environment suites.
- Running an SDK suite from the app asks which project environment to run it in, and launches it there without attaching it; a project with no runnable environment says so.
