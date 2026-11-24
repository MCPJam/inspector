---
"@mcpjam/sdk": minor
---

New platform operations `start_climb`, `update_climb`, `get_climb` and `list_climbs`, with the matching `PlatformApiClient` methods and the `climbs` feature gate on each. A climb improves a saved server from an eval suite, one round at a time, in the suite's environments: `start_climb` needs a round limit and a credit limit, splits the suite's cases into steering, validation and confirmation cases, and launches the baseline twice through a mock with no changes.
