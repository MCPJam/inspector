## Task, spec and plan

<!-- All three lines stay. A non-blocking check comments when one is blank.

Every change gets a task, including a one-line fix. If there isn't one, make one —
it takes a few seconds and it is how the work becomes findable later.

Spec and Plan are different: plenty of changes genuinely need neither. Write
`None: <reason>` for those. A bug fix, a revert, a dependency bump, a copy tweak
and a mechanical refactor are all good reasons, and nobody will query them.

Spec means a spec that existed BEFORE the code — a Kestral spec, a design doc,
something someone agreed to. It is not a second copy of this description. If the
user story, acceptance criteria and architecture below are the spec, say so and
move on; that is the normal case, not a cop-out. -->

- **Kestral task:** <!-- PP-96, or https://app.kestral.ai/workspace/yhNILB2/task/… — required -->
- **Spec:** <!-- link to a spec agreed before the code, or None: covered by the user story and acceptance criteria below -->
- **Plan:** <!-- link, or 3 to 6 bullets of the approach you agreed before writing code, or None: <reason> -->

## User story

<!-- Who this is for and what they can do after it merges. Name a specific persona: "hosted evals user", "self-hosted admin", "on-call engineer", not "the user". -->

**As a** ...,
**I want** ...,
**so that** ...

### Acceptance criteria

<!-- 3 to 7 conditions a reviewer can check without asking you. Pattern: [thing] [does / shows / prevents] [behavior] [under condition]. Include the error state, not only the happy path. Tick each one you verified. -->

- [ ] ...
- [ ] ...
- [ ] ...

## What this does

<!-- One paragraph on why the code is this way now. Leave the narration of the diff to the diff. -->

## Architecture

<!-- Required when the PR adds a component, moves a boundary, or changes how data or requests flow. A Mermaid block renders on GitHub. Draw only the parts this PR touches and label each arrow with what crosses it. Otherwise write "None: no new component or flow".

```mermaid
flowchart LR
  Client -->|"POST /api/evals/run"| Server
  Server -->|"runs.create"| Convex
```
-->


## Screenshots and recordings

<!-- Required for any visible change. Use before and after for a static change and a short recording (under 60 s) for an interaction, loading state or error path. Otherwise write "None: no UI change". -->

| Before | After |
| --- | --- |
|  |  |

## Deleted

<!-- Files, functions or paths this removes, or "Nothing". If a v2 lands here, name the v1 and when it goes. -->

## Reused

<!-- Existing helpers, components or modules this builds on instead of writing new ones, or "Nothing applicable". -->

## Production signal

<!-- The event, metric, log or alert that shows this works after deploy, or "None: not user-facing". -->

## Checklist

- [ ] I can explain every line of this diff without the agent that wrote it.
- [ ] Under 400 hand-written changed lines, or labelled `large-pr` / `mechanical`.
- [ ] No new `as any`, empty `catch`, `.catch(() => {})` or raw `console` on the server.
- [ ] Comments say why the code is this way, not how it got here.
