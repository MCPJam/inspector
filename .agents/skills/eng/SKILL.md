---
name: eng
description: Take an engineering task from prompt to PR on one Kestral task. The engineer approves a product spec, an engineering spec and a fresh-agent-reviewed plan; you draft them, build, log decisions, capture sessions, verify the acceptance scenarios and assemble the review page and PR body. Use when the engineer accepts the flow when a hook offers it, types /eng, or asks to resume or revisit a step.
---

# Engineering flow

The engineer approves two things: the specs, then the reviewed plan. You do
the rest and record it as you go. Kestral holds every artifact. The local
record that the hooks, resume and the review page read is kept by

```bash
node scripts/eng/cli.mjs <command>   # "eng <command>" below
```

Use your Kestral connector for every task, document, comment and upload. The
hooks run outside your session and cannot call Kestral; they tell you what is
pending and you do it.

## Start or resume

The hooks offer the flow once per branch, on a build-shaped prompt or on the
first source edit, whichever comes first. Ask the engineer in one sentence.

- **Yes.** Find or create the Kestral task, then
  `eng link <KEY> --url <task url>`. One task covers the whole effort:
  stacked branches and work in both repositories link to the same key.
- **No.** `eng decline`. Neither nudge fires again on this branch.
- **/eng**, or a fresh session. `eng status` and continue from its "Next".
  On a checkout with no local record, read the latest checkpoint on the task,
  save it to a scratch file and `eng restore --file <path>`.

## Sync to Kestral

Every change to the task record queues the workflow checkpoint, and later
steps queue decision comments, session records and screenshots. `eng pending`
lists what waits and whether to create it or update the document it already
is. Save each with your connector, then `eng synced <id> --ref <kestral id>`.
If an earlier attempt may have landed, search the task for the
`<!-- eng:... -->` marker at the end of the body before creating anything, so
a retry never duplicates a document or comment. If Kestral is unavailable,
tell the engineer and carry on; the queue survives the session and the
worktree, and the review page lists whatever is still unsynced.

The checkpoint is what a fresh checkout restores from.

## Specs

Draft both from `templates/`, then save each on the task as a document.

- **Product spec** (`templates/product-spec.md`): who it is for, intended
  behavior, non-goals, acceptance scenarios, open decisions, and a user-flow
  or state diagram.
- **Engineering spec** (`templates/engineering-spec.md`): current and
  intended architecture, affected repositories, reuse and deletion,
  interfaces, failure handling, verification, rollout, and an architecture or
  sequence diagram.

Keep the split the billing pages use: what a customer sees or decides goes in
the product spec; how it is built goes in the engineering spec. Keep each
summary to about one screen and link the detail rather than leave out a
consequential decision. Label every diagram and description current,
proposed or implemented.

For a user-visible change, also create the UI diff from
`templates/ui-diff.md` before asking for approval. Without one, the
engineering spec says "None: no UI change."

Record each saved document with its Kestral id and version:
`eng doc product-spec --ref <doc id> --revision <version>`, and the same for
`engineering-spec` and `ui-diff`. Without a version, export the document and
pass `--file <export>` to hash it.

Show the engineer both specs and ask for approval. Record it only when they
give it: `eng approve specs`.

## Plan

1. Draft the plan from `templates/plan.md` (five sections), save it and
   `eng doc plan ...`.
2. Have a fresh agent review it. It must not inherit your conversation:
   Claude Code, a subagent; Codex, a new `codex exec` session; Cursor, a new
   chat. Give it `templates/plan-review.md` filled in with the task, both
   specs, the plan and the code paths it touches, and nothing else.
3. Write each finding with your disposition (`accepted`, `rejected` or
   `deferred`, plus a note) to a JSON array and
   `eng review --file <findings.json> --revision <reviewed revision>`. Post
   the findings and dispositions on the task.
4. Revise the plan, save it, `eng doc plan ...` with the new revision.
5. Show the engineer the plan and the review. On approval, `eng approve plan`.

Leave the filled-in review prompt on the task as a comment, so the engineer
can run a second agent on it themselves.

## Build

Build to the approved plan. A material change to approved behavior, scope or
architecture reopens the approval it touches: `eng reopen specs --reason ...`
(which reopens the plan too) or `eng reopen plan --reason ...`, update the
document, and ask again. A routine implementation choice only needs a
decision entry.

Log each consequential decision as you make it:

```bash
eng decision --what "Queue uploads in the git common dir" \
  --why "Survives worktree removal" --alternatives "Per-worktree file" \
  [--by "<who decided>"] [--supersedes D2] [--long-lived]
```

It queues one task comment: what, why, alternatives and who decided. A
reversal names the entry it supersedes. `--long-lived` flags a decision for a
person to promote to a lasting document; never promote one yourself.

When a turn that changed source ends, the Stop hook asks you once to
reconcile those changes with the approved plan: record the missing decisions,
or `eng reconcile --none` if nothing material changed. The same reminder
lists records the turn queued for Kestral. It fires at most once per turn and
never blocks an edit, a commit or a PR; if you cannot act on it, say why and
finish.

## Setup, once per machine

1. Add the Kestral connector in each agent you use (Claude Code, Codex and
   Cursor IDE) and sign in. The flow needs task, document, comment and
   upload access.
2. Trust the project's hooks. Claude Code reads `.claude/settings.json`.
   Codex reads `.codex/hooks.json` only in a trusted project, and skips a
   changed hook until you trust it again with `/hooks`; do that after every
   pull that changes the file. Cursor reads `.cursor/hooks.json` in a trusted
   workspace. Cursor CLI is not supported.
3. Check with `eng hooks`. A host whose hooks "have not run" or ran "from an
   older" config is skipping them: re-trust, then start a new session.

Without hooks the flow still works from `/eng`, but nothing offers it,
reminds you to reconcile decisions or captures sessions. Say so to the
engineer when `eng hooks` shows it.

## Writing

Apply the `engineering-writing` skill to the prose you write: specs, plan,
decisions, review page and PR body. Leave literal commands, results and
quotations as they are.
