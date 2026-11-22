---
name: pr-evidence
description: Capture the screenshots, recordings and console findings a UI pull request attaches, with the inspector driver's record and compare commands, and fill the PR template's "Screenshots and recordings" section from the evidence.md they write. Use after a visible change is committed and before opening or updating its PR.
---

# PR evidence

A reviewer checks a UI change by looking at it. The inspector driver records
the same steps on the base ref and on your branch, in light and dark, and
writes an `evidence.md` that goes under "Screenshots and recordings" in the
PR body. Start and drive instances as the `run-inspector` skill describes;
this skill covers what to capture and what to put in the PR.

## Write the steps

One steps file that opens the changed surface and exercises the change, in
the `run` format from the `run-inspector` skill. Take selectors from an
`.aria.yml` that `open` wrote. Keep the run under a minute: the recording is
the whole run.

```json
{
  "start": "servers",
  "steps": [
    { "click": "role=button[name=\"Add server\"]" },
    { "waitFor": "role=dialog" }
  ]
}
```

## After only

Commit first. A recording of uncommitted changes names no commit a reviewer
can check out, and `evidence.md` says so.

```bash
node mcpjam-inspector/scripts/inspector-driver.mjs start --env-file <profile>
node mcpjam-inspector/scripts/inspector-driver.mjs record steps.json --out <evidence>/after
node mcpjam-inspector/scripts/inspector-driver.mjs stop
```

`record` runs the steps in light, then dark, each in a fresh browser with
video. It prints the usual report for each theme and the path of
`evidence.md`. `--theme dark` records one theme; the other then shows as
"not captured".

The commit in `evidence.md` is the instance checkout's HEAD and dirty flag,
read before the capture and again after it; `record` refuses to write
evidence if they differ, and it first checks the instance `start` recorded
still answers to its own token. The dev server serves the working tree, so
that is the code it ran, except the SDK and bundles built when `start` ran:
`start` again after changing those. `record` deletes any `evidence.json` and
`evidence.md` in the folder before it captures, so a failed attempt leaves no
manifest pointing at a mix of old and new files.

## Before and after

Check out the base ref in a second worktree and start its instance from your
branch's driver with `--checkout`. The driver records the base worktree's
commit and resolves surface ids from the base worktree's own surface list, so
the base ref does not need the driver itself.

```bash
git worktree add <base-worktree> origin/main
# link node_modules into it the way this worktree has them
node mcpjam-inspector/scripts/inspector-driver.mjs start --checkout <base-worktree> --env-file <profile>
node mcpjam-inspector/scripts/inspector-driver.mjs record steps.json --checkout <base-worktree> --out <evidence>/before
node mcpjam-inspector/scripts/inspector-driver.mjs stop --checkout <base-worktree>

node mcpjam-inspector/scripts/inspector-driver.mjs start --env-file <profile>
node mcpjam-inspector/scripts/inspector-driver.mjs record steps.json --out <evidence>/after
node mcpjam-inspector/scripts/inspector-driver.mjs stop

node mcpjam-inspector/scripts/inspector-driver.mjs compare <evidence>
```

`compare` writes `<evidence>/evidence.md` with before and after side by
side. It refuses two records whose steps (compared field by field, not by
their printed text), viewport, browser mode or `--fresh` differ, and it
shows only the themes both records captured. Both instances
can run at once; `start` picks free ports for the second.

## Put it in the PR

1. Paste `evidence.md` in place of the template's "Screenshots and
   recordings" section.
2. Attach each file named in an `[attach ...]` placeholder where the
   placeholder is. Images go in the table; `.webm` recordings upload the
   same way.
3. Leave every "not captured" line in. Say why on the same line if you
   know.

Do not upload evidence anywhere else. Never attach the launcher log, any URL
carrying `#token=`, or a screenshot that shows account data you would not
paste in the PR.

## What counts as evidence

- A screenshot or recording with the commit it ran against, the date, the
  viewport and the steps that produced it. `evidence.md` carries all four.
- The console and network findings from that same run, including warnings.
- A before/after pair recorded with one steps file.

## What does not

- A screenshot with no date or commit, or of a commit other than the PR's
  head. Record again after the last commit that changes the UI.
- A recording of uncommitted changes.
- A crop that hides an error toast, a console ISSUE line, or the other theme.
- A screenshot from the dev server you were editing in, instead of a driver
  run. It has no steps, so nobody can reproduce it.

## When something is not captured

Write "not captured" and the reason, in the PR body, for anything the
template asks for and you could not produce: a theme, the before side, a
signed-in flow, a recording. Never drop the row. A missing row reads as
"nothing changed there", which is a claim you have not checked.
