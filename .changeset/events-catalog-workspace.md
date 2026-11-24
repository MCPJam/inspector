---
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

Browse Events, Subscriptions, and Occurrences from one shared inspector header. Select an item in the left list to inspect it in the workspace, with subscription forms inline and expandable Event type details and Raw JSON sections. Remove the separate All events view and show rejected deliveries only when present under Occurrences. Keep manual event triggering in Playground, where an agent is attached. Remove server diagnostics and the internal delivery metadata dump from the workspace, and simplify the local webhook opt-in.

Name Playground actions Connect event and Edit instructions, clarify that manually triggering sends new test data rather than replaying an occurrence, and remove obsolete background-trigger guidance. Update CLI Events terminology and describe watch cleanup separately for poll, push, and webhook.
