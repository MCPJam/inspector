---
name: eng
description: The MCPJam eng flow from Kestral task to PR. Use when the engineer accepts the eng flow offer, when a session-start hook says this branch belongs to a Kestral task, when the engineer types /eng to jump to or redo a step, when asked to open a PR on a mapped branch, or when asked why code is the way it is.
---

# Eng flow

Agents draft, engineers approve. The engineer approves twice (specs, then plan)
and types no commands. You run `node scripts/eng/eng.mjs` to keep state; it
lives in `.git/eng/`, shared by every worktree and never committed.

Every document lives on the Kestral task. Link the task, never a local path.
Every piece of prose you write (specs, plan, log entries, page, PR body) goes
through the `engineering-writing` skill first.

A missing tool degrades the step, visibly; it never fails it. No Kestral: keep
the documents in the chat, skip uploads, and say so in the PR body. No subagent
tool: run the review as a separate pass that reads only the plan and specs, and
say so. No Artifact tool: upload the review page to the task instead.

## Where you are

The session-start hook tells you the task and step. Without it, run
`node scripts/eng/eng.mjs status`. `/eng <step>` from the engineer jumps to or
redoes a step; otherwise move forward only on their "yes" or approval.

| Step | Name    | Run on entry                     |
| ---- | ------- | -------------------------------- |
| 01   | task    | `eng.mjs map <PP-123> <url>`     |
| 02   | specs   | `eng.mjs step specs`             |
| 03   | plan    | `eng.mjs step plan`              |
| 04   | review2 | `eng.mjs step review2`           |
| 05   | build   | `eng.mjs step build`             |
| 06   | review  | `eng.mjs step review`            |

## 00 · Offer

The hooks ask you to offer the flow once per branch. One sentence, then wait.
On no, run `eng.mjs decline` and carry on without it. On a main branch, create a
work branch first.

## 01 · Task

Link the task the engineer names, or search Kestral for one. If none fits,
create it in the right project with a one-paragraph description. One task per
piece of work: every branch of a stack maps to the same task, and a new branch
stacked on a mapped one inherits it (confirm with `eng.mjs map`). Then move
straight to 02.

## 02 · Specs

Interview the engineer with the `grilling` skill until you can write both specs
without guessing. Then write them side by side from
[templates/product-spec.md](templates/product-spec.md) and
[templates/eng-spec.md](templates/eng-spec.md): one screen and one diagram each.
The eng spec lists every repo the work touches; each gets its own PR on this
task. Ask for one approval of both. On approval, upload both to the task as
documents and continue. No plan exists before this approval.

## 03 · Plan

Draft the plan from [templates/plan.md](templates/plan.md), using
`codebase-design` for module boundaries. Before the engineer sees it, start a
fresh subagent that has none of your reasoning, give it the specs and plan, and
have it run the `adversarial-reviewer` skill on the plan. Revise. Log each
finding you act on or reject as a decision (below). Then show the engineer the
revised plan with a one-line summary of what the review changed, and ask for
approval. On approval, upload the plan to the task.

## 04 · Second review (optional)

Post [templates/review-prompt.md](templates/review-prompt.md), filled in, as a
task comment, so the engineer can paste it into a different agent or model.
Tell them it is there and move on to 05; do not wait. When its findings come
back as task comments, log each one you act on.

## 05 · Build

Use `tdd` for new behavior and `diagnosing-bugs` for failures. Follow
AGENTS.md for size, errors, types and checks.

Each change of direction (a planned approach dropped, a new dependency, a
scope cut, a reversal) gets a decision entry before you continue. The Stop hook
reminds you once if a turn changed direction with nothing logged.

Commits get a `Kestral: <PP-123>` trailer from the `prepare-commit-msg` hook.
If hooks are off, add the trailer yourself.

## 06 · Review

Starts when the engineer asks for a PR.

1. Run `code-review` on the branch and fix what it finds.
2. Build the review page from [templates/review-page.md](templates/review-page.md):
   specs, decision timeline, plan vs actual. Nothing else. Publish it as a Claude
   Artifact shared with the org; without one, upload it to the task.
3. Write the PR body from `.github/pull_request_template.md`, every section
   filled as AGENTS.md says. Line one is the review page link. Task, Spec and
   Plan link the task and its documents. Keep it short; the page holds the rest.
4. Upload this session's record (below) and any the start hook listed.

## Decision log

One Kestral task comment per decision, from
[templates/decision.md](templates/decision.md): what, why, alternatives, who.
A reversal cites the entry it overturns. A decision that should outlive this
work (a convention, a boundary) is flagged for `docs/decisions/` in the entry;
never write it there yourself. Promotion is a human call.

## Session record

The Stop hook keeps a full, redacted record of each session that did work in
`.git/eng/sessions/`. Before uploading, tighten its prose with
`engineering-writing`: collapse noise, keep every entry and timestamp, drop
nothing, and re-check that no secret survived. Upload it as its own document on
the task, titled `Session <date> <agent>`, then run
`eng.mjs uploaded <session-id>`.

## Why is it like this?

Follow `git blame` to the commit, its `Kestral:` trailer to the task, then the
decision log and session records on that task. Quote the entry and link it. If
there is no entry, say so; do not invent a reason.

## The other repo

The start hook names where the other MCPJam repo is and how far behind
origin/main it is. Read it from `origin/main`, not its working tree. Run
`eng.mjs repos` to look again.
