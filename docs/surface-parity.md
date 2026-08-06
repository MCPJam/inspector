# Agent surface parity

This is the acceptance checklist for adapters. The shared core owns semantic
copy, targeting, claims, history ordering, and delivery handles; each adapter
owns native rendering.

| Feature | Slack | Discord (MVP) | Teams (spike) |
| --- | --- | --- | --- |
| Agent turn | Events API mention/DM | Gateway guild mention | Activity handler |
| Thread context | `conversations.replies` | `messages.fetch` (Message Content intent) | Activity history |
| Live progress | `chat.update` | Message edit by ID | `updateActivity` |
| Proposals | Block Kit | Components (`custom_id = actionId`) | Adaptive Card `Action.Execute` |
| Evidence | `files.uploadV2` | Attachments | Separate attachment activity |
| Connect | App Home link | `/mcpjam connect` ephemeral interaction | Sign-in card spike |
| Private nudges | `postEphemeral` | Interaction contexts only | Card update/DM |
| Dedupe | `slackEventClaims` | Same claims with `discord:` key | `teams:` key |
| Install record | `slackInstallations` | `surfaceInstallPresence` | Conversation reference spike |

Discord MVP intentionally excludes DMs: a DM has no guild tenant, so it cannot
be mapped to a surface account without an explicit tenant/org picker design.
