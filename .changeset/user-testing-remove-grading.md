---
"@mcpjam/inspector": patch
---

User Testing: the Grading card is removed from a study's Settings. That takes out the Grading header and enable/disable toggle, its description, the session sample percentage field and the whole Checks list. Sharing permissions, Ratings and Delete stay where they were, so Ratings now sits directly above Delete. The client-side pieces that only served that card are removed with it: the `ScenarioGradingSection` component and its tests, the `setProductionScoring` mutation binding, and the `productionScoring` field and `ProductionScoringSettings` type on the client's scenario settings shape.

This is a UI removal only. The backend production-grading pipeline is unchanged: the backend `setProductionScoring` mutation, the idle-triggered enqueue, stored `productionScoring` configs on existing studies, and the Inspector's production-checks worker are all as before, and the pipeline remains gated by the backend's `PRODUCTION_CHECKS_ENABLED` flag. Grading in Evals and Swarms is unchanged.
