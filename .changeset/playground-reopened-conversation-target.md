---
"@mcpjam/inspector": patch
---

A reopened Playground conversation no longer describes itself with your current settings

Opening `/playground?conversation=<id>` restored the transcript and then framed
it with whatever the viewer happened to have selected. A conversation that had
run on a Cursor CLI harness host, against an environment, with the deepwiki
server attached, reopened showing an unrelated host chip, `Claude Sonnet 5`,
**Environment · none**, and another server's tools. The natural conclusion —
"this never ran on Cursor" — was wrong, and the more expensive one followed from
it: a reply typed under those chips ran on the target they named, so asking the
Cursor transcript "what harness are you" got a Claude answer.

**The chips were never about the conversation.** The previewed host and
environment live in per-project browser storage (`use-previewed-client-id`,
`use-previewed-environment-id`), which restore does not touch — by design, since
they are the viewer's working state. What was missing is that the composer said
so nowhere.

**What the session actually records**, and what it does not:

- `modelId` and `resumeConfig.selectedServers` are persisted and were already
  restored.
- `resumeConfig.environmentId` is persisted **only** for Agent Playground
  (`origin: "api"`) sessions, and the browser ignored it entirely.
- The **host** and, for browser Playground turns, the **environment** are not
  persisted at all. `chatSessions.hostId` is stamped only for scenario- and
  swarm-sourced rows, which the direct-chat read never serves; the browser
  turn's `resumeConfig` carries no target field. `chatSessionTurnTraces` does
  hold `environmentAtTurn` and `hostConfigId` per turn, but neither is projected
  into the read the Playground uses.

So the composer now says which of those it is standing on. A reopened
conversation that recorded no target gets **"As-run configuration unavailable"**
naming the target a reply would actually use; one that pinned an environment
different from the selected one is named outright. Nothing is inferred and no
default is dressed up as history — absence is reported as absence.

Continuing on a different target is legitimate, so this is a one-click
acknowledgement rather than a refusal — but it has to be the user's act, which
is the part that was missing. Until it is given, the composer's Send is disabled
and **every** way to start a turn refuses, not just the button:

- the composer submit (Enter, the Send button, eval Quick Run);
- widget-driven follow-ups, which bypass the composer entirely;
- starter chips, which are a one-click send from the empty state;
- "Ask agent to run" on a harness built-in tool, which the Tools rail requests
  from a sibling subtree through a store;
- editing a past message, which is a send **and** a fork — it would run the
  edited turn on the ambient target and mint a branch recording that it did.
  The edit action is shown disabled rather than failing on click.

A gate that covered only the composer would have been theatre. The two prompt
paths keep their text as a composer draft rather than dropping it, so accepting
the target and sending is one more click, not a retype. The acknowledgement is
per conversation and survives a reactive refresh of that same conversation; New
Chat, a detach and a rewind branch drop it.

The disclosure is derived only on the two paths that EXPLICITLY open a
conversation — the history rail and the `?conversation=` restore — and never
from the reactive Convex refresh, which also runs for the live chat once it
adopts a session id. It is bound to the live session id, so a fork or reset
retires it without a second clear path to keep in step.

Restoring the recorded environment automatically is deliberately **not** part of
this: selecting one changes the chat scope key, and the reset that follows wipes
the very transcript being restored. Naming it is honest today; adopting it needs
the restore to run after the scope settles.
