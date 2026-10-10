---
name: meticulous-increase-coverage
description: Increase coverage for a Meticulous project by tracing specific under-covered files back to a real UI action in the codebase, driving that action with a real recorded browser session, and validating the improvement with a clean coverage comparison. Also opens a PR proposing .meticulousignore entries for code that structurally never executes in-browser. Use when asked to "increase coverage", "find untested code", or "add .meticulousignore entries" for a project.
user-invocable: true
---

# Increase coverage for a Meticulous project

> Run `meticulous-cli-update` first if you haven't already this conversation (it also covers authentication and project selection).

## What you deliver

Two separate outputs, both expected — neither substitutes for the other:

1. **One or more test runs from newly recorded sessions that provably extend coverage.** "Provably" means a comparison against the baseline naming the files whose coverage went up, and by how much (Step 7). If a target turns out not to be coverable, say so rather than padding the list.
2. **A PR proposing `.meticulousignore` changes.** Only include paths — most often whole directories — that you are _confident_ are not coverable at all. Anything you merely failed to reach in one sitting does not belong there; leave it out and mention it in the PR description instead.

## Before you start: run this on `main`, with a clean tree

Every command below relies on the CLI resolving things from your local checkout: `js-coverage` defaults to the current git HEAD, `trigger-test-run` defaults to HEAD for the deployment and to the merge-base with the origin default branch for the base. On `main` with a clean tree those collapse to a single commit, which is exactly what you want — no diff, a head-only run, and a union in Step 7 that the API will actually accept.

Off `main` this breaks in ways that are tedious to unpick: union coverage is rejected unless every run executed the _exact same_ commit, and a PR's merge commit is recomputed whenever its base branch moves, so a run triggered earlier against a since-advanced base no longer unions with a new one.

So: check out `main`, pull, and make sure `git status` is clean before Step 1.

Then confirm there is actually a test run to work from:

```bash
meticulous agent test-run-for-commit
```

Keep the id it prints — Step 7 falls back to it. If it reports **"No test run found for commit …"**, stop and report that to the user; you cannot baseline without it. The most common cause is the CLI pointing at the wrong project, so suggest they check with `meticulous auth get-project`. `meticulous auth set-project` only applies for OAuth tokens; API tokens are bound to one project (so `set-project` fails), and injected credentials leave no local token to select — in those cases the fix is a different credential, not `set-project`.

## Step 1 — Baseline coverage

Take the headline figure. It's one call, and it's the number Steps 7 and 8 compare against:

```bash
meticulous agent js-coverage --summary
```

Don't dump per-file coverage for the whole repo. Every question in this skill is a narrow query (one directory, or the worst files first), so one page answers it. Each paged command reports on stderr which rows you got and how many files matched (`files 1-50 of 8214; …`). Read that notice: the total is often the answer.

If this reports **"No test run found for commit …"** (it shouldn't, if the check above passed), stop and report to the user. Do not work around it by baselining against some other commit's run: Step 7's union requires your new run and the baseline to have executed the same commit.

The base run's sessions often haven't all been replayed yet, which understates its coverage — if `js-coverage` says so, run `meticulous agent complete-base-run` (it waits by default until nothing more can be scheduled; it can take a while, so check back or re-run rather than assuming it hung), then re-run `js-coverage`. Don't expect `unexecutedSessionCount` to always reach `0` — some sessions can be permanently unobtainable, and `js-coverage` tolerates a small share of those rather than refusing forever.

## Step 2 — Separate dead code from real targets

You are looking for two different things, and it helps to keep them apart:

- **`.meticulousignore` candidates**: files that are _uniformly_ at 0% across a whole directory, which suggests they never execute in a browser at all.
- **Coverage targets**: files a real user flow could reach but that no recorded session happens to reach.

Each has its own queries, all built on `--orderBy`. It ranks every file in the run that has executable lines on the server, 0% files included (types-only files are left out) (no `--includeAllFiles` needed), and breaks ties by path. `--globFilter` scopes a query to a directory and can be repeated.

### Ignore candidates

Start here, since they shrink the list. Go directory by directory, taking the directories from the repo's own layout (`ls packages/` in a monorepo, the top-level source directories in a single app), not from coverage data. For each one, ask for its most-executed file:

```bash
meticulous agent js-coverage --globFilter "packages/<name>/**" \
  --orderBy=executedLines --includeLineCounts --limit=1
```

- **`executedLines` is 0 even for that file:** every file in the directory is at 0%, and the stderr notice says how many there are. That strongly suggests the directory never ships to the browser (backend, CLI tooling, docs, e2e test harness), so it's a `.meticulousignore` candidate.
- **No files match:** the directory is already outside the coverage report, and a rule for it would do nothing.
- **Anything else:** the directory is live. If you suspect a dead corner inside it, check its subdirectories the same way.

There's a second, stronger signal that doesn't depend on coverage data at all. It catches individual dead files scattered inside an otherwise-live directory, which the per-directory check misses entirely. List a live directory's 0% files (they sort first, by path; stop paging once rows rise above 0%):

```bash
meticulous agent js-coverage --globFilter "<live-dir>/**" \
  --orderBy=coveragePercentage --order=asc --includeLineCounts --limit=100
```

For each one, grep the codebase for its actual exported symbol, not just its filename:

```bash
# example only — adjust the source root and extensions to this repo
grep -rn "theActualExportedName" <src-root> --include="*.ts" --include="*.tsx"
```

If the only match is the file's own definition, nothing imports it, so no session — however comprehensive — can ever execute it. That is proof of unreachability, not an inference from silence, and it is worth checking even when you already have a directory-level rule elsewhere in this file: dead exports accumulate inside packages that are otherwise very much alive.

Some categories are **safe exclusions almost everywhere** and are worth proposing without further tracing, provided the per-directory check agrees they are uniformly 0%. It takes globs like `**/__tests__/**` or `**/*.stories.*` just as well as a directory:

- test files and their directories — `__tests__/`, `__mocks__/`, `*.test.*`, `*.spec.*`
- Storybook — `*.stories.*`, `__stories__/`, `.storybook/`
- test/mock harness directories — `testing/`, `mocks/`, fixtures
- build, lint and codegen config executed only by Node — `*.config.*`, `setupTests.*`, scripts directories

Some of these may already be outside the coverage report entirely. A glob that matches no files needs no rule.

Be suspicious of a directory showing 0% everywhere if you _know_ it is bundled into the frontend (a shared component/utils library the main app imports). That pattern is more likely a source-map/path-attribution gap than genuinely dead code — leave it out of the ignore list and flag it as unresolved.

### Coverage targets

These are **not only the 0% files**. A file at 12% or 40% usually means one path through it runs and the rest doesn't. Those partial files are often the cheapest wins: the module already loads, so a single extra interaction can light up a large block. Start with the files that have the most to gain, scoped to the app's real source so test, story and ignore-candidate files stay out:

```bash
meticulous agent js-coverage --globFilter "<app-src>/**" \
  --orderBy=uncoveredLines --includeLineCounts --includeCoveragePercentage \
  --limit=50
```

This mixes 0% and partial files, and the percentage column tells them apart. Where the gain is comparable, prefer a partial file over a 0% one. To see the least-covered partial files instead, use `--orderBy=coveragePercentage --order=asc`. There's no filter that leaves out 0% files, so that listing starts with the whole 0% block; page past it with `--offset`.

Group the candidates by feature area rather than picking the single worst files. One recorded flow usually moves a whole cluster of related files at once, so a directory sitting at 5-20% across a dozen files is a better target than an isolated 0% file behind an obscure branch. Re-run the query scoped to a feature directory to see that cluster.

Some 0% or low files are gated behind a feature toggle that's off by default, rather than sitting on a UI path nobody has driven. Check the toggle registry and the file's gating condition before assuming it needs a brand-new flow: turning the toggle on locally can make a dead-looking file an easy target.

## Step 3 — Trace, don't guess

For each candidate file, find its actual caller(s) — for example:

```bash
# example only — adjust the source root and extensions to this repo
grep -rln "<ExportedThing" <src-root> --include="*.tsx" | grep -v test
```

Read the caller. Confirm:

- It's reachable via a simple, describable UI action (a specific button, a specific menu item) — not buried behind a feature flag, a disabled config (e.g. billing/SSO toggles that are off in this environment), or a conditional branch that only fires for certain object types.
- If the target is a **hook**, check every branch that calls it. Hooks are often called conditionally — one branch might route through a completely different mechanism (a plain router `<Link>` instead of the app's own navigation hook, a side-panel open instead of a full navigate). Confirm which branch your candidate action actually hits.

## Step 4 — Drive the flow

**Any of these three drivers records correctly** — verified against two different apps:

- **Claude in Chrome** — the only one that drives the user's own signed-in Chrome profile, so an authenticated app needs no login flow. Its input path is also the one that wedges (see below), so verify early and be ready to switch.
- **Playwright** and **`agent-browser`** — CDP-launched browsers, faster and more scriptable, and reliable in every test here. The trade-off is a fresh profile each time, so you have to sign in. `agent-browser` additionally refuses a click when the target is covered by another element, naming the covering node, which catches a class of silent mis-click the other two will happily perform.

**Set a realistic viewport** whichever you pick. The CDP browsers default to something small (around 1280px wide) where a real Chrome window is often twice that. Responsive layouts render different components at different widths, so the default viewport can quietly cover different code — or hide the control you were aiming for.

What matters far more than the choice of tool is the one rule below.

**Only trusted events are recorded.** The recorder ignores anything synthesised in page JS, so `element.click()`, assigning `input.value`, or dispatching your own events all drive the app convincingly and record _nothing_. The page looks right, the session comes back empty. Drive everything through the tool's real input actions.

When something doesn't take effect, find out which half is broken before changing tactics — install a capturing probe and repeat the action:

```js
window.__ev = [];
["pointerdown", "click", "keydown", "change"].forEach((t) =>
  window.addEventListener(
    t,
    (e) => window.__ev.push({ t, trusted: e.isTrusted }),
    true,
  ),
);
```

- nothing captured → your input never reached the page; a different selector or coordinate won't help (see the wedged-extension note below)
- captured but `trusted: false` → it reached the page but will not be recorded; you are synthesising somewhere

### Three ways an action records as nothing

All three look like success in the browser, which is what makes them expensive — you find out from the coverage numbers, long after the fact.

**Native `<select>`s.** Setting the value through a form-fill action, or assigning it in JS, fires a `change` with `isTrusted: false` — the app reacts and the value visibly updates, so it looks like it worked, but the recorder ignores it and the sort/filter never happens on replay. Clicking the `<select>` is no good either: that opens an OS-level popup the driver can't see. What works is to focus the element and press the **first letter of the option's visible text** (`"p"` → "Priority"), which yields a trusted `keydown` _and_ a trusted `change`. Repeat the letter to cycle options sharing an initial. Verify with a `change` listener reading `e.isTrusted` — the value updates either way, so the value alone tells you nothing.

**Modifier shortcuts.** Replay reproduces a modifier only if a _discrete_ modifier keydown was recorded and is still held. Some drivers send one only for the base key: Claude in Chrome's `cmd+k` and `agent-browser`'s `press Alt+ArrowRight` both record a single keydown with the modifier flag set and no separate modifier press, so on replay the flag is cleared and the handler body never runs — while working perfectly live. Playwright's `press('Alt+ArrowRight')` does record the discrete press and replays correctly (verified by coverage).

So: prefer the equivalent _click_ target where one exists, and if you must use a chord, drive it with Playwright and confirm from coverage afterwards. If the line holding `if (… && event.metaKey)` is covered but the body is not, the keydown was delivered and the condition evaluated false — that is this.

**Double-clicks.** A double-click may be recorded as a single click, in which case the replay never fires `onDoubleClick` and every later event in that session targets UI that never opened — so coverage _drops_. Check the recorded event count looks like two press/release pairs, and treat any double-click-only feature as suspect until coverage confirms it.

### Some interactions may not survive agent-driven recording at all

Occasionally an interaction records cleanly and visibly works live, but the handler it's meant to trigger never fires on replay — with no error, and the affected file sitting at _exactly_ its baseline percentage in Step 7's union. One case seen: typing a value into an input inside a dropdown's own portal-rendered content (a filter chip, a view rename behind a "..." menu). Plain clicks in the same portal, and the identical type-then-Enter sequence on an input in the main page tree, both replay fine — so this is specific to keyboard/text input inside a portal, not a driver issue.

Don't assume a typed-value target worked just because the live interaction did — check Step 7's diff. If a target only reproduces through this kind of interaction and won't move, that's a shortcoming of agent-driven recording for this flow: report it as unresolved and suggest a human drive that one flow manually, rather than continuing to pad the list with retries.

### `claude-in-chrome` specifics

- **Screenshots are downscaled** (~0.6x), so they are not CSS pixels. Click coordinates read off the screenshot, or scale a `getBoundingClientRect()` centre by `screenshotWidth / window.innerWidth`. Re-derive after any resize, and re-screenshot rather than reusing coordinates from an earlier page — layout shifts, and a stale coordinate can land on the wrong element and record an interaction you did not intend.
- **Re-acquire a `ref` immediately before clicking it**, and never reuse one across pages or tabs. Don't predict a number — `read_page` does not emit them in order. Refs and coordinates are equally reliable; pick whichever is convenient. This is not unique to `claude-in-chrome` — `agent-browser`'s `snapshot` refs go stale the same way, and reusing one silently clicks whatever now occupies that ref, not what you intended. It cost a real mistake once: a stale ref landed on a table's "Add New" affordance and created a blank record. Take a fresh snapshot immediately before every click when the DOM might have changed, and treat an unexpected page/record-count change right after a click as a sign a ref just misfired, not as an unrelated bug — clean up whatever it created before continuing.
- **Input delivery wedges intermittently.** Every click and keystroke reports success, reads keep working, and nothing reaches the page. Refs and coordinates die together, so this is never a selector problem — and it is not cleared by a new tab, a fresh navigation, waiting, or retrying. A full Chrome restart helps but does not durably fix it. **Check the probe after your first interaction, before driving a whole flow**, and if input isn't landing switch to Playwright or `agent-browser` rather than switching selector method. Both stayed reliable throughout, including on the same page at the same moment that Claude in Chrome was dead.

### Drive it, then verify

1. Navigate to the target URL and drive the real action.
2. Confirm it worked against the DOM (e.g. `document.body.innerText.includes(...)`), not just a screenshot — a tooltip appearing can look like success. Check you are still on the page you think you are: an app that has quietly redirected you to a login screen will absorb blind coordinate clicks into empty space and hand you a session with zero events.
3. **Close the tab.**

Then sanity-check the recording, before you trigger anything. Wait ~10s after closing the tab, so the session is complete, and check that it captured something:

```bash
meticulous agent sessions --limit 10 --excludeSyntheticSessions \
  --includeDurationSeconds --includeNumberUserEvents \
  --includeNumberUrlsVisited --includeStartUrl --includeAbandonedReason
```

Read the row you just produced:

- **no row at all** — nothing was uploaded yet; wait a little longer before concluding the recording failed
- **`numberUserEvents` of 0** — the recorder saw no user input. Your clicks were not reaching the page, or were synthesised rather than trusted; go back to the input-delivery probe above. Replaying this session is pointless.
- **`numberUrlsVisited` of 1 when you navigated several times** — the later pages did not make it into _this_ session. They either landed in their own sessions (fine, collect those ids too) or were swallowed as an unreplayable tail (see the hard-navigation note in Step 5).
- **`durationSeconds` over 300** — everything past the 5-minute mark will be silently trimmed on replay (Step 5). Re-record the overflowing part as its own session rather than hoping it survives.
- **populated `abandonedReason`** — the recorder gave up on the session (see the 10-minute cap in Step 5); it is not worth replaying.
- **`startUrl` that is not the page you drove** — the navigation you cared about belongs to a different session than you assumed.

**A session is only complete once its tab is closed.** While the tab is open the row reflects only the chunks uploaded so far, so a low or zero `numberUserEvents` there means "not flushed yet", **not** "the recording failed". A session measured for this skill read **0** events with the tab open and **12** once it was closed. Judging it early nearly caused a perfectly good recording to be re-driven from scratch.

Events upload on a short interval (a few seconds), but anything still unflushed at unload is only stashed in `sessionStorage` and re-sent on a _later page load to the same origin_ — so a session's tail can be delayed until the next visit. Prefer navigating away over hard-closing the browser, and never judge a recording immediately.

**Recording several targets in one sitting? Run this check after _each_ one**, not just once at the end. Checking only at the end makes it impossible to tell which action lost a session, and you'll have to re-drive all of them just to find out which one needs redoing.

## Step 5 — Session-time budget and close discipline

- **Cloud replays cap at 5 minutes of session time.** Everything recorded after that is silently trimmed from the replay — the run still succeeds and reports itself accurate, so the loss is invisible unless you look for it (snapshot routes stop early; far fewer allowed events than the session has clicks). Don't leave this to feel: `agent sessions --includeDurationSeconds` gives you the number, and anything over 300 is losing its tail.
- **Your interaction pace eats this budget.** Each find/click/verify round trip is 10-60s of _recorded_ session time. Plan the flow completely before opening the tab, batch your actions into as few round trips as possible with short waits between them, verify from the recording afterwards rather than mid-flow, and aim to stay under 4 minutes. Several short sessions beat one long sweep.
- **Direct URL navigation is a legitimate fast path** to each target page and replays fine — prefer it over slow click-paths. But hard navigations split the recording into multiple sessions, so collect every resulting session id afterwards and pass them all to `--sessionIds` (Step 6). Mostly this is fine, each piece staying under the replay cap. The trap is navigating again too quickly: a page reached a second or two after the previous one gets appended as the _tail_ of that session instead of starting its own, and tails frequently do not replay — so the page renders perfectly while you drive it and still contributes no coverage. Give each page you actually care about its own dwell time (~10s) before moving on, and check in Step 6 that it shows up as a `startUrl` in its own right. The same caution applies to a plain `<form>` submit with no wired `onSubmit` handler — it triggers a real browser reload rather than an SPA transition, and can just as easily drop the just-recorded, unflushed session if you navigate on immediately afterward.
- **Recorder limits:** a 10-minute hard cap on tab-open time marks the whole session "abandoned"; uploads flush on a 5s interval — wait ~6-8s after the last interaction before closing the tab.

## Step 6 — Collect the session ids and trigger the test run

First list what you actually recorded, newest first:

```bash
meticulous agent sessions --limit 20 --excludeSyntheticSessions \
  --includeDurationSeconds --includeNumberUserEvents \
  --includeNumberUrlsVisited --includeStartUrl
```

Skip any row with `numberUserEvents` of 0 — it will replay as nothing and only dilutes the run. Note any row with `durationSeconds` over 300: it will replay, but only its first five minutes, so treat coverage from its tail as absent rather than assuming the whole flow ran.

Identify your sessions by recorded-at time and `startUrl`. Be careful here: other people — and other apps pointed at the same project — record too, so never assume the newest N rows are yours. `--recordedSince` and `--visitedUrlFilter` are the quickest way to narrow it down when the list is busy.

Expect **more sessions than pages you drove**: a hard navigation usually ends one session and starts another, so a five-page sweep can produce five ids. Collect all of them. A page whose URL never shows up as a `startUrl` was probably swallowed as the tail of the previous session and will not replay — re-record it on its own if you need it covered.

Then trigger:

```bash
meticulous agent trigger-test-run --sessionIds "<id1>,<id2>,..."
```

## Step 7 — Compare with a union, not a raw diff

Start with the aggregate. It answers "did anything move at all" in one call, and you can compare it directly with the `--summary` from Step 1:

```bash
meticulous agent js-coverage --summary --headPlusTestRunIds "<newRunId>"
```

This unions your new run into the baseline run resolved from HEAD (the same run Step 1 used), so it is baseline coverage **plus** your new sessions' coverage. Commit resolution skips runs over an explicit session set, so the run you just triggered won't be picked as the baseline. You need the union because `--sessionIds` _replaced_ the selected set for that run rather than adding to it. On its own, your run covers far less than the baseline, and comparing against it directly would read as mass regressions. A union can only add coverage, so its figure is never below Step 1's.

Pass only your new run: a run cannot be unioned with itself.

Then ask about the files you set out to cover. Pass each target (repeat `--globFilter`), once with the union and once without it for the baseline:

```bash
meticulous agent js-coverage --headPlusTestRunIds "<newRunId>" \
  --globFilter "<target1>" --globFilter "<target2>" \
  --includeLineCounts --includeCoveragePercentage
meticulous agent js-coverage \
  --globFilter "<target1>" --globFilter "<target2>" \
  --includeLineCounts --includeCoveragePercentage
```

Two signs that HEAD resolved to something other than the golden-set run: the union is **rejected** with "is the run being queried", or its summary is _below_ Step 1's (you unioned into another narrow session set; it's not a regression). The most likely cause is a pinned-session run that predates the skip. Either way, name both sides explicitly, using the baseline id from Step 0:

```bash
meticulous agent js-coverage --summary --testRunIds "<baselineRunId>,<newRunId>"
```

Use the same `--testRunIds` in place of `--headPlusTestRunIds` for the per-target query.

If the union is rejected because the runs executed different commits, that is the `main`/clean-tree precondition biting — see the top of this skill.

## Step 8 — Verify and report

For each traced target file: did coverage move? For each `.meticulousignore` candidate from Step 2: did it stay at 0% in the union? Re-run Step 2's per-directory check with `--headPlusTestRunIds "<newRunId>"` added. If `executedLines` is still 0, nothing your sessions did reached it.

If a well-traced target didn't move, don't assume the recording failed — re-check the session first (Step 4: does it exist, did it capture user events and URL visits, is it abandoned, is its `startUrl` the page you drove?), then re-check whether the click actually goes through the file you expected (Step 3) rather than a sibling/parent component. Report honestly if a target remains unresolved; don't claim success without the coverage number to back it.

The test run proves the coverage is reachable, but nothing changes for recurring runs until the sessions are in the selected set. Promote the ones that moved a target, rather than waiting for the next session selection to pick them up:

```bash
meticulous agent promote-sessions --testRunId="<newRunId>" \
  --sessionIds="<id1>,<id2>"
```

Pass only the sessions that earned it — the ones Step 7 shows gaining coverage — since every promoted session runs in every test run from then on. Omit `--sessionIds` only when all of them did. The next session selection re-ranks them with the rest of the set and drops any that turn out redundant.

The response's `updatedBaseTestRunId` is your commit's updated base run: the baseline plus your promoted sessions' replays. It takes a few minutes to post-process, and until it has, the commit still resolves to the old base run — so a plain `js-coverage` right after promoting returns the **old** figure, with nothing to say it is stale. Read the updated run by its id instead, which waits for it to finish:

```bash
meticulous agent js-coverage --summary --testRunId="<updatedBaseTestRunId>"
```

Quote that number in your report: it is the commit's own figure with the promotion in it, and should match the Step 7 union. If `updatedBaseTestRunId` came back empty, the notice on stderr says why; report the Step 7 union instead.

Promotion is refused unless your commit's base run has replayed its whole selected set, so if you skipped `complete-base-run` in Step 1, run it now and promote again. It is also capped: at most 20 sessions per call, and at most 10% of the project's configured selected-set size between two session selections. If you hit the cap, promote the sessions with the largest gains and name the rest in your report.

## Step 9 — Open the `.meticulousignore` PR

The second deliverable. Branch, commit the `.meticulousignore` change, and open a PR.

**Only propose paths you are confident are not coverable at all.** The bar is "no session could ever execute this", not "I didn't get to it today". Prefer directory-level rules over long lists of individual files — a directory rule stays correct as files are added, whereas a file list silently goes stale. In practice most entries come from the safe-exclusion categories in Step 2 plus whatever whole non-browser packages Step 2's per-directory check showed at a uniform 0%.

Confirm before you commit: every path you are about to ignore stayed at 0% in the union (Step 8's check). A path your own new sessions just covered obviously doesn't belong in the ignore list, and that check catches it.

A common structure, especially in monorepos, is "ignore everything, then un-ignore what does run in the browser":

```
# Ignore everything except packages that are executed in the
# browser and have meaningful frontend coverage.

packages/*
!packages/<frontend-app>/
!packages/<frontend-app>/**
!packages/<shared-ui-lib>/
!packages/<shared-ui-lib>/**
```

Note that `.meticulousignore` follows gitignore semantics, so a file cannot be re-included once its parent directory is excluded — un-ignore the directories (`!some/dir/**/`) as well as the files.

In the PR description, give the reasoning for each rule — _why_ this code cannot run in a browser (it's a Node-only build script, a test harness, a backend package). The baseline can only show you that something is at 0% today, which is never proof it is unreachable, so the justification has to come from what the code actually is. Also call out explicitly:

- anything you left **out** of the ignore list despite low coverage because you suspect a source-map/attribution gap rather than dead code (Step 2)
- anything unreachable only because of environment or feature-flag config rather than structurally — that is the reviewer's judgement call, not yours, so flag it instead of silently ignoring it

## Reference

`references/worked-example.md` runs the whole skill against a small app (kanban-demo), with the real coverage deltas. Worth reading for calibration: it has no 0% files at all, one target that gained coverage and one that recorded cleanly and then failed to replay — and it shows how to tell the difference from executed ranges.
