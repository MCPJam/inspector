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

## The other repository

Backend and Inspector work often spans both. `eng repos` finds the other
checkout, read-only: `MCPJAM_INSPECTOR_DIR` or `MCPJAM_BACKEND_DIR` first,
then the cached path, then a bounded search. It reports the path, branch,
revision and how far it is from the local `origin/main`, which is only as
fresh as that checkout's last fetch; say so when it matters.

Never clone, fetch, pull, reset or switch the other checkout. If it is
missing, say so and carry on with what does not need it. Ask the engineer
for its path only when a required step cannot happen without it.

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

## Verify

Add each acceptance scenario from the approved product spec with
`eng scenario add "<scenario>"`, then record what happened:

```bash
eng scenario S1 passed --evidence "npm run test:once -- upload: 4 passed"
eng scenario S2 failed --evidence "<log or artifact>"   # back to build
eng scenario S3 unverified --note "No staging access"
```

A pass or failure needs evidence; each result records the commit and
whether the tree was clean. A failed scenario sends the effort back to build.
Verify against committed code so the evidence matches the PR.

For a user-visible change, finish the UI diff before review. Name the
states that apply (`eng ui states default,loading,empty,error,permission,narrow`),
capture each one from the running build with the existing browser or
screenshot tools, and record it:
`eng ui shot <png> --phase actual --state error --steps "<how to reproduce>"`.
Record proposed visuals the same way with `--phase proposed` before spec
approval. Each shot is queued for upload with its label. `eng ui` lists what
is missing; record departures from the proposal with `eng ui deviation` and a
decision. Pair a screenshot with a test, network log or backend check when
appearance alone cannot prove the behavior. With no UI change, `eng ui none`.

## Session records

On a linked branch the hooks keep one record per agent session: at every
Stop and at session end they read the new part of the host's transcript,
redact credentials, and rebuild the record (prompts, answers, commands with
their output folded, edits, commits, checks and decisions, in order). It is
queued like any other record; sync it whenever you sync the rest, and before
the PR. Long sessions split into parts.

The record states what it could not see: "unavailable" when the host gave
no transcript, "partial" when lines could not be read, and events without
timestamps. Never fill those gaps from memory; say what is missing.

## Why is this line here?

Commits on a linked branch get a `Kestral: <KEY>` trailer from the
`commit-msg` git hook, whoever commits. Keep it when you rewrite a message.
To answer why code is the way it is, run `eng why <file>:<line>`: it follows
the blame to the commit, its trailer to the task, and lists the decisions
recorded locally. Read the task's decision comments and session records
before answering. When the commit has no trailer, say that no record exists
rather than guess.

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
