---
name: error-message-review
description: Classify user-facing error messages in a pull request as pass or fail against the Errors section of DESIGN.md. Use when reviewing a diff that adds or changes a toast, alert, inline field error, error-boundary fallback, or ERROR_CATALOG entry.
---

# Error message review

The rules live in **`DESIGN.md`, section "Errors"** — checks E1–E4, the surface
table, and the tone rules. Read that section before reviewing. Do not restate,
summarize or reinterpret the rules here; when this file and DESIGN.md disagree,
DESIGN.md is right and this file is the bug.

This file holds only the mechanics: what to look at, in what order to decide, and
what to write.

## What to review

**In scope.** Any string that can reach a reader as a failure or a block:
`toast.error`, `toast.warning`, `<Alert variant="destructive">`, `ErrorCard`,
inline field and form errors, error-boundary fallbacks, empty states shown
*because* something failed, and `ERROR_CATALOG` entries.

**Out of scope. Never flag these.** `console.*`, telemetry, log lines, thrown
errors that are caught and mapped before display, test fixtures, code comments.
Log verbs and error codes are correct in logs. A changed line that is out of scope
gets **N/A**, not pass.

Invoke this skill in a repository-capable review. Claude Code discovers it through
the `.claude/skills/error-message-review` symlink; run `/error-message-review`.
Codex and Cursor can load this file from `.agents/skills/`. It is not wired into
`claude.yml` or the string-only CI classifier.

Read the full working tree, not only the diff. Open the surrounding function when
deciding the surface, and grep sibling messages when checking E4's one-name-per-
thing rule. Neither judgment is safe from the changed line alone.

## Order of decision

Apply every check in order to in-scope messages and report all established
failures. Stop only for an out-of-scope string; do not infer a failure when the
required context is unavailable.

1. **In scope?** No → **N/A**.
2. **E1, plain language.** A raw `error.message`, response body, stack fragment or
   bare error code as the message → **FAIL**.
3. **E2, precisely indicates the problem.** Names neither what failed nor which
   thing, or is a generic message standing alone → **FAIL**.
4. **E3, offers a way out.** No next step and no affordance, and the reader is not
   genuinely powerless → **FAIL**.
5. **Surface.** Validation in a toast, or a message carrying a real cause and real
   next steps in a toast instead of `ErrorCard` → **FAIL**.
6. **Tone.** Blames the reader, uses "invalid" or "illegal", minimizes ("simply",
   "just", "easily", "quickly"), clears its throat ("Looks like", "It seems",
   "Unfortunately", "Oops"), or carries an em dash or emoji → **FAIL**.
7. **E4, consistent.** A failure verb other than "Couldn't" → **FAIL**. A different
   name for a thing other messages already name → comment, don't fail; it needs
   the other strings in view and you may not have them all.
8. Otherwise → **PASS**.

## Prevention, as a comment only

If the state that triggers the message was preventable — the Run button could have
been disabled, the field could have had a default — say so in **one** line,
prefixed `Prevention:`, and never repeat it if the author does not act. It is a
product call, so it never blocks a merge and never becomes a FAIL. If you have
nothing specific, say nothing.

## What to write

Every FAIL names the check, quotes the string, and gives a replacement. A verdict
without a replacement makes the author guess, and guessing is how one product
ended up with four failure verbs.

```
FAIL E1, E4 · ServerConnectionCard.tsx
  `Failed to export ${server.name}: ${errorMessage}`
  → "Couldn't export {server.name}." plus an ErrorCard from describeError(err)
```

Sentence shape: `Couldn't <action> <object>.` `<Cause>.` `<Next step>.` Drop the
second and third sentences when E2's cause is unknown or E3's exemption applies.

## Calibration

These strings occur at the linked call sites. Read the surrounding controls before
applying the listed checks. Catalog entries must meet E1–E4 too; their schema is not
a copy verdict.

| String | Source | Verdict | Why |
| --- | --- | --- | --- |
| `` `Failed to export ${server.name}: ${errorMessage}` `` | [ServerConnectionCard.tsx](../../../mcpjam-inspector/client/src/components/connection/ServerConnectionCard.tsx) | FAIL E1, E4 | Raw exception tail and a log verb in front of a reader |
| `toast.error("Please select a valid JSON file")` | [JsonImportModal.tsx](../../../mcpjam-inspector/client/src/components/connection/JsonImportModal.tsx) | FAIL surface | Validation in a toast, away from the control |
| `"Could not load live client templates"` | [CreateHostDialog.tsx](../../../mcpjam-inspector/client/src/components/hosts/CreateHostDialog.tsx) | FAIL E4 | Wrong failure verb |
| `"Couldn't apply that edit. Try again."` | [ChatTabV2.tsx](../../../mcpjam-inspector/client/src/components/ChatTabV2.tsx) | PASS | Names the action and gives the step |
| `"Create or join an organization to create projects."` | [use-project-state.ts](../../../mcpjam-inspector/client/src/hooks/use-project-state.ts) | PASS | The recovery is the message |
