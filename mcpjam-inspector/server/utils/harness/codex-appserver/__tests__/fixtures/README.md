# Recorded app-server streams

Each `.jsonl` file is a sequence of `codex app-server` frames as they arrived on
the wire, one JSON object per line, in order. `stream-translator.test.ts` replays
them through the translator and validates every emitted part against the
framework's own `harnessV1StreamPartSchema`.

They are recordings, not hand-written mocks, and that distinction is the point:
a hand-written fixture encodes what we BELIEVE codex sends, and agrees with the
code for exactly as long as the belief holds. These were captured from the
pinned 0.149.1 binary by `.spike-codex-appserver/probe/run-gates.mjs`, which
writes `artifacts/<gate>.ndjson`; the capture script's `direction: "in"` frames
are what appear here, with volatile ids left as recorded.

Server REQUESTS (the approval calls) are kept inline rather than filtered out,
because their position in the stream is part of what the fixture pins: codex
sends `item/commandExecution/requestApproval` and the matching `item/started`
in the same millisecond, with the item first in every recording here. The
protocol orders neither, so the translator seeds the tool call from whichever
arrives first — these fixtures pin the order actually observed.

To re-record after a codex bump:

```sh
cd .spike-codex-appserver
node probe/record-fixtures.mjs --codex <path-to-codex>
```

## What is here, and what is not

| Fixture | Covers |
| --- | --- |
| `command-approved.jsonl` | reasoning deltas, an approved command, agent text |
| `command-declined.jsonl` | a denied command (`status: "declined"`, no execution) |
| `text-and-reasoning.jsonl` | streamed reasoning summary + streamed text, no tools |
| `shell-write.jsonl` | a second command shape, writing through a nested path |

There is deliberately **no `fileChange` fixture**. A `fileChange` item comes from
Codex's `apply_patch`, which is not a function tool the model can be scripted to
call — the scripted provider can only drive `exec_command`, and a shell write
reports as `commandExecution`, not `fileChange`. Rather than hand-forge a
`fileChange` frame and test our own imagination, the translator's fileChange
path is covered by unit cases in `stream-translator.test.ts` that are labelled
as constructed, and by the live suite when a real model is available.
