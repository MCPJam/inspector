---
"@mcpjam/inspector": patch
---

User Testing: Grading is removed, behavior included, not just the card. A study's Settings no longer shows the Grading card (enable toggle, description, session sample percentage, Checks list), and the pipeline behind it is retired: nothing samples or enqueues real tester sessions for production grading any more, the config mutation the card wrote through is gone, and a backend migration flips every existing study's stored `productionScoring.enabled` to false so already-configured studies stop grading regardless of the deployment flag. Sharing permissions, Ratings and Delete stay where they were, so Ratings now sits directly above Delete. Grading in Evals and Swarms is unchanged.
