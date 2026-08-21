---
"@mcpjam/inspector": patch
---

An auth-walled readiness run names its one next step

A run against an OAuth server with no token completes honestly — dozens of
checks gray, the verdict amber, nothing red — but the section left the reader
to infer what to do about it, and the agent surfaces had the same facts with
no instruction attached.

The section now shows a banner when two facts agree: this run carried no
token (`authMode: "headless"`), and the server challenged correctly (a
satisfied `unauthenticated-challenge` finding, or an `authorizationRequests`
gap). Either alone stays silent — headless-alone is every run against every
open server, and the banner would nag universally. Together they mean one
action closes the gaps: connect the server with OAuth and run again. Nothing
readiness-specific to configure — a hosted run reads the saved token
automatically, which is why the banner can promise it.

The agent learns the same rule through a prompt note keyed to the same two
machine-readable fields, ending in the same instruction: connecting earns the
server its remaining grades; the challenge it already gave earned it green
marks, not red ones.
