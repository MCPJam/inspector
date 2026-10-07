---
"@mcpjam/sdk": minor
---

Muse readiness results carry `readinessKind: "muse-directory-readiness"`, with `isMuseReadinessResult`, and render through `toConformanceReport` under their own name. The platform client adds `startMuseReadinessRun` and the `start_muse_readiness_run` operation; `PlatformReadinessKind` gains `muse` and `PlatformReadinessLane` gains `tool-policy`.
