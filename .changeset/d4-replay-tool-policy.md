---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Carry an eval run's tool policy into its replays. A replay re-dials the original
servers with the original credentials, so a replay that lost the policy executed
for real the calls the source run blocked. The effective policy is now
snapshotted per iteration and recovered at replay time; a source run that shows
policy activity without a recoverable snapshot refuses to replay instead of
running unrestricted. Also documents that `toolPolicy.allow` is an override, not
a whitelist.
