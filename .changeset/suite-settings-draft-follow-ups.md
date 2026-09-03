---
"@mcpjam/inspector": patch
---

A settings draft belongs to one suite, and its concurrency check now runs

Five follow-ups from review of the draft-and-commit sheet. The first two are
the ones that mattered.

**Unsaved edits followed you to another suite.** The draft lived in a
component that is not remounted between suites, and the effect that used to
reset it per suite went away with the per-control writers. Rebasing keeps
every key the person edited — that is the whole point of it — so opening
suite A, typing a name, confirming "leave without saving" and clicking suite
B left A's name proposed as an unsaved change on B, and saving wrote it
there. A draft now carries the suite it belongs to, and a rebase across
identities starts a new one instead of reconciling.

**Confirming the prompt now actually discards.** The guard only paused the
navigation; nothing threw the draft away, so the edits survived, every later
navigation re-prompted, and ⌘S opened the review dialog from pages that have
no settings sheet.

**A conflict marker survived only until the next unrelated change.**
Conflicts were recomputed from the new base each time, so a colleague
renaming the suite cleared the warning about the threshold you had both
changed, and the next save overwrote theirs silently. A conflict is now
resolved by the person, by editing the key or discarding.

**Renaming had two writers.** The header's inline editor still committed on
blur — no review, no note, no precondition — while the sheet drafted the
same field. Using it marked the sheet as "changed elsewhere" for the
person's own action, and the next save overwrote the rename. The header
title is read-only in the sheet; the overview keeps its own editor.

**The accuracy input kept showing a discarded number.** It held its own text
state and never followed the prop, so Discard reverted the draft while the
field still displayed the old value — a settings control saying one thing
while a different thing gets saved.

Also: pass criteria is omitted rather than sent as `null` (the mutation's
validator has no null member, so a clear would have failed the whole batched
save), an absent judge config reads as "Not configured" rather than "Off"
(absent resolves to an enabled advisory judge), and on a deployment without
the composite mutation the fallback drops fields that backend does not
declare and names them in the toast, rather than failing every save in the
draft.
