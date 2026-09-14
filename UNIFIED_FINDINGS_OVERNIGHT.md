# Unified Findings — overnight experiment (Inspector)

An answer to one question: **can we explain what failed in an eval run,
accurately and usefully, without AI — and does adding the recorded judge
evidence make AI advice better?**

The first half is built and inspectable in a browser right now, with no cloud
credential of any kind. The second half is built and **unvalidated**: no model
was called, so nothing here is evidence that AI improves anything.

The backend's paired handoff is at `UNIFIED_FINDINGS_OVERNIGHT.md` in the
`mcpjam-backend` checkout. It has the schema, the gate and the miner's rules.
**The 20-minute review is here, in §8.**

---

## 1. The two branches

|           | Repository                               | Branch                        | Base                                       | Head                                       |
| --------- | ---------------------------------------- | ----------------------------- | ------------------------------------------ | ------------------------------------------ |
| Inspector | https://github.com/MCPJam/inspector      | `claude/happy-meitner-4s02o4` | `94ee2a53db53eac0228361c7427e75a58330b32a` | see `git log -1`                           |
| Backend   | https://github.com/MCPJam/mcpjam-backend | `claude/happy-meitner-4s02o4` | `0bd3f3070ffabe4fe78a943f531b3bcaa016b53c` | `95a81f6c9ce2076ca438a4543be2d2899e4c6c1a` |

**On the branch name.** The brief asked for `experiment/unified-findings-overnight`.
This session is pinned to `claude/happy-meitner-4s02o4` in both repos and refuses
pushes elsewhere, so that is where the work is. Nothing else differs: both are cut
from the recorded `origin/main`, neither is merged, neither touches `main`.

**Backend schema-expansion rollback target:**
`45a92a2ffb12829825d6f2942791138e27ed35ec`. See the backend handoff.

### What is and is not true of this work

| Piece                            | State                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| Both branches pushed             | **Yes**                                                                                          |
| Merged                           | **No**, and neither should be                                                                    |
| Deployed anywhere                | **No.** No Convex deployment was touched; no env var changed on any existing deployment.         |
| Tested locally                   | **Yes** — see §7                                                                                 |
| Tested against a live deployment | **No.** Repository access only.                                                                  |
| Real model calls                 | **Zero.**                                                                                        |
| AI quality validated             | **No.** _AI quality not yet validated on real model output._                                     |
| Visual inspection                | **Yes** — headless Chromium, light/dark/narrow, all states. Screenshots attached to the session. |

---

## 2. Get it on your machine

```sh
cd ~/code/inspector
git fetch origin claude/happy-meitner-4s02o4
git worktree add ../inspector-findings claude/happy-meitner-4s02o4

cd ~/code/mcpjam-backend
git fetch origin claude/happy-meitner-4s02o4
git worktree add ../mcpjam-backend-findings claude/happy-meitner-4s02o4
```

Install, backend first (its install is seconds; the Inspector's is a minute):

```sh
cd ../mcpjam-backend-findings && npm install
cd ../inspector-findings && npm install --legacy-peer-deps
```

The preview needs **no** build: it resolves `@mcpjam/sdk/platform` from source
and imports only types from it.

---

## 3. The offline preview (no cloud, no keys, ~2 minutes)

```sh
# in the BACKEND checkout — runs the real miner over the frozen corpus
npm run findings:replay -- --fixtures --mock-enrichment --out /tmp/unified-findings-replay.json

# here
npm run findings:preview -- --replay /tmp/unified-findings-replay.json
```

Open **http://localhost:5175** (`--port` to change it; it falls back to the next
free port). `--build` writes a static bundle to
`mcpjam-inspector/client/dev/findings-preview/dist/` instead of serving.

The page renders **the app's own components** from the backend's replay
artifact. Not a mock, not a second renderer: `UnifiedFindingsPanel`,
`FindingSummary`, `FindingEvidenceList` and the real `finding-prompts.ts` prompt
builder are the ones the Evaluate page mounts. If the preview and the app ever
disagree it is because a component differs, never because the lab computed
findings its own way.

What the controls do:

- **Case** — the fixture selector. Names match the files in the backend's
  `tests/fixtures/eval-findings/`.
- **Synthetic inputs** / **Real recorded evidence** — a badge on every case.
  Fixtures are synthetic; a bundle exported from a real run says so instead.
- **Mocked AI output — plumbing only** — appears when the artifact was built
  with `--mock-enrichment`. Those rows exercise the enrichment _join_. They are
  not evidence that a model improves anything and the page says so.
- **Simulate state** — the lifecycle states the panel has to get right:
  not-built, building, build-failed, AI-running, AI-failed, older-backend.
  These simulate the props, never the data; the findings are always the real
  miner's output for the selected case.
- **Dark / Light** — theme toggle, for looking at both.

Drop `--mock-enrichment` for a run with no AI tab at all, which is the state a
real run is in until someone asks for one.

---

## 4. Where the code is

| Responsibility                       | File (under `mcpjam-inspector/client/src/`)                        |
| ------------------------------------ | ------------------------------------------------------------------ |
| Envelope contract + the one selector | `lib/insights-envelope-api.ts`                                     |
| Provenance labelling rules           | `components/shared/actionable-insights/finding-provenance.ts`      |
| Evidence disclosure + typed locator  | `components/shared/actionable-insights/finding-evidence.tsx`       |
| One finding, as three answers        | `components/shared/actionable-insights/finding-summary.tsx`        |
| The panel (lead + secondary, states) | `components/shared/actionable-insights/unified-findings-panel.tsx` |
| The controller                       | `components/shared/actionable-insights/use-unified-findings.ts`    |
| Evaluate mount                       | `components/evaluate/unified-findings-section.tsx`                 |
| Client flag                          | `hooks/useUnifiedFindingsEnabled.ts`                               |
| Offline preview                      | `client/dev/findings-preview/`                                     |
| SDK contract (additive)              | `sdk/src/platform/types.ts`                                        |

**The client's third copy of the envelope types is gone.**
`lib/insights-envelope-api.ts` now aliases the SDK's published types instead of
hand-maintaining its own. Every exported name is unchanged, so no call site
moved; a field added to the SDK now reaches every component without anyone
remembering to re-type it.

### What a finding answers

1. **What happened** — the deterministic observation, first and always. It is
   the sentence that survives when narration fails, and the one you can check.
2. **What supports that** — the exact evidence, one disclosure away, with a
   typed `{ kind: 'iteration', id }` locator. No component inspects an id's
   shape to guess what it points at.
3. **What to do next** — headed _What to change_ only when the backend promoted
   the finding; otherwise _What to investigate_. The pinned tool contract and
   the server-fix prompt appear only behind `isServerReady`.

Every prose field carries its source: **Standard guidance** (the deterministic
fallback), **AI explanation** (a model wrote _this field_, per-field), or the
recorded judge evidence, which renders as evidence rather than as our words.
The origins are producer-owned — the backend computes them, the client never
sniffs text.

### The two operations are deliberately different words

- **Build findings** — free, deterministic, says _"Reads this run's recorded
  evidence. Does not use AI."_ on its own line.
- **Add AI explanation** — metered. Never fires on mount, never on a view
  switch, never when evidence is opened. All three are pinned by tests.

Separate loading and error states, separately tested: a model failure leaves
every observation on screen.

---

## 5. Turning it on against a dev deployment

**Never point this at production.** Full instructions and the deployment order
are in the backend handoff §5; the Inspector half is:

| Name                                                       | Value that turns it on |
| ---------------------------------------------------------- | ---------------------- |
| `VITE_UNIFIED_FINDINGS` (in `mcpjam-inspector/.env.local`) | `1` (exactly)          |
| …or `localStorage["mcpjam.experiment.unifiedFindings"]`    | `"1"`                  |

The env flag needs a Vite restart. The localStorage key does not — set it in
the console and reload; another tab flipping it takes effect without one.

**Route:** `/evaluate` → a suite → a settled run. The section is titled
**"What broke, and what to do about it"** with an _Experiment_ chip, directly
above "Worth a look, never required". The old presentation is untouched and
still there — that duplication is intentional for this branch and is what makes
the comparison possible.

**Flag off ⇒ the section is not mounted at all**: no extra query, no extra DOM.

**Older backend:** if this client has the experiment and the connected backend
does not, the panel says so and offers nothing. It does not retry a missing
function and never implies the experiment ran. If the backend serves it but its
write gate is off, the panel says _that_ instead — a different sentence for a
different problem — and anything already built still reads.

---

## 6. Three examples worth opening

All three are in the offline preview.

1. **`repeated-attributable-failure`** — the base case.

   > `"search" failed (401) on server acme-crm in 6 of 20 iterations that reached the "call" stage on gpt-5.4-mini · emulated.`

   Open _What supports this?_: three quoted failures and one contrasting
   success from the same host/model partition, each with an **Open iteration**
   link. Note what it does **not** claim — attribution `unknown`, action
   _investigate_, no server-fix prompt. A 401 is not evidence that the server
   implementation is defective. Switch to **Previous analysis** for what the
   existing pipeline said about the same run ("Improve error handling").

2. **`missing-and-version-ahead-evidence`** — an honest unknown.
   Two of eight iterations analyzed, with every exclusion named. Six iterations
   produce no finding, which is the correct answer rather than a quieter one.

3. **A rejected AI result** — any case, **With AI explanation**. The note reads
   e.g. _"1 explanation matched a finding; 1 row was rejected for naming a
   finding that does not exist or naming one twice."_ (`many-groups`: 10
   accepted, 3 rejected.) The mock deliberately emits a reordered list, a
   missing entry, an unknown id and a duplicate id. Observations survive all
   four.

One more pair, worth opening together: **`all-green`** (12 iterations, all
passed, zero findings — _ready_) next to **`nothing-measurable`** (6 iterations,
every one excluded, zero findings — _unavailable_). Same empty list, opposite
meanings, and the panel says which is which:

> _"Nothing in this run could be measured. Every iteration was excluded — see
> the coverage below — so there is no honest finding to show, which is different
> from finding nothing wrong."_

**The copy action was exercised in a browser**, not just in a unit test: clicking
_Copy investigation prompt_ on `hostile-and-secret-evidence` put a 1,697-character
prompt on the clipboard, built by the real `finding-prompts.ts`. The canary API
key planted in that fixture's evidence is **absent** from it, the untrusted
evidence is fenced, and the heading reads _"Investigate a problem observed across
sessions"_ rather than anything about fixing a server — because the backend never
promoted that finding.

Screenshots (attached to the session): deterministic light / dark / 420px, the
AI view with per-field labels, the evidence drawer, the baseline comparison, the
unavailable state, and the not-built / AI-failed / older-backend states.

---

## 7. Checks

| Check                         | Command                                                                                           | Result                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Client typecheck              | `npx tsc --noEmit -p client/tsconfig.typecheck.json`                                              | **pass**                                                   |
| Preview typecheck             | `npm run typecheck:findings-preview -w @mcpjam/inspector`                                         | **pass**                                                   |
| SDK typecheck                 | `npm run typecheck -w @mcpjam/sdk`                                                                | **pass**                                                   |
| SDK build                     | `npm run build -w @mcpjam/sdk`                                                                    | **pass**                                                   |
| SDK tests                     | `npm run test -w @mcpjam/sdk`                                                                     | **pass** — 8,221                                           |
| Repo checks                   | `npm run test:checks`                                                                             | **pass**                                                   |
| Findings components           | `npx vitest run --project client client/src/components/shared/actionable-insights/__tests__/`     | **pass** — 78                                              |
| Evaluate components           | `npx vitest run --project client client/src/components/evaluate`                                  | **pass** — 1,167 in 93 files                               |
| Wire parity                   | `npm run check:findings-wire-parity -w @mcpjam/inspector -- --backend ../mcpjam-backend-findings` | **pass**                                                   |
| `npm run design:check`        |                                                                                                   | **pass**                                                   |
| `npm run design:lint`         |                                                                                                   | **pass** — 0 errors (109 pre-existing warnings, unchanged) |
| Preview build, fresh checkout | `npm run findings:preview -- --replay … --build`                                                  | **pass**                                                   |
| Visual inspection             | headless Chromium, 16 states                                                                      | **done**                                                   |
| Live run against a deployment |                                                                                                   | **not run**                                                |
| Real model call count / cost  |                                                                                                   | **none**                                                   |

The wire-parity check **fails when it cannot compare**. It needs
`--backend <path>` (or `MCPJAM_BACKEND_DIR`); with neither it exits non-zero
saying so rather than printing "skipping" and passing. The fixture it compares
is produced by the backend's real envelope query after a real build and a real
enrichment attach, and this repo's copy is type-checked against the SDK's
`InsightsEnvelope` — so a field the backend sends that the SDK does not declare
fails the client typecheck instead of being silently dropped.

---

## 8. Your 20–30 minute review

**1 — Offline, ~10 minutes.** Start the preview (§3). Open
`repeated-attributable-failure`, expand the evidence, and check the count
against the iterations it names. Then open
`missing-and-version-ahead-evidence` and satisfy yourself that the unknown is
stated rather than papered over. Judge: _does the lead finding tell me
something true, and could I act on it within two minutes?_

**2 — Dedicated dev, ~10 minutes** (optional; the only part that touches a
deployment). Follow the backend handoff §5, then pick **5–10 settled runs with
known failures**. Press **Build findings** on each — no AI, no spend. For each
run record: is the top finding **correct**, and does it give a **usable next
step** inside two minutes?

Keep unmeasured runs **in the denominator** as their own reported category
("built, nothing measurable"), not as silent exclusions. Expect several: see
limitation §9.3 — an emulated run has no structured tool evidence, so its
findings name a stage and a reason with no tool. That is honest, and it is also
the main thing standing between this and a genuinely useful answer on emulated
suites.

**3 — AI, selectively.** On the same snapshots, press **Add AI explanation** on
a few. Compare _With AI explanation_ against _Observations_ and against
_Previous analysis_. Rate each **worse / no improvement / useful improvement**,
one sentence each. A critical unsupported claim **fails the case** even if the
prose reads well.

**4 — Break it on purpose.** Remove the model key (or let a generation fail) and
confirm the observations are still on screen and still correct. Then change the
run's evidence — re-run its judge — and press **Rebuild findings**: the old AI
advice must be _gone_, not reattached to the new counts. The panel says so
explicitly when that happens.

### The decision rule (yours to judge, not mine to certify)

- **Zero** wrong evidence attachments and **zero** critical unsupported causes.
- At least **4 of 5** adequately-measured reviewed runs yield a correct, usable
  deterministic finding.
- AI adds a specific, supported improvement on at least **3 of 5** reviewed
  snapshots — _before_ any further investment in the AI half.

Report the sample size and the measurement coverage with the verdict. Five to
ten runs guides a product decision; it is not a statistical claim about
enterprise reliability.

If deterministic findings help and AI does not: keep the deterministic
direction, defer the AI investment, and the branch is already shaped for that —
the deterministic path has no model dependency anywhere. If both are weak, the
missing evidence is the thing to fix first, and §9.3 names it.

---

## 9. Known limitations

1. **No live run has ever been built.** Everything is fixtures plus tests
   against the real modules.
2. **No model has ever run this prompt.** _AI quality not yet validated on real
   model output._
3. **Emulated runs get no tool identity.** Structured tool-failure evidence
   comes from `evalHarnessToolCalls`, which only harness-hosted runs (Claude
   Code / Codex) produce. An emulated run's findings group by stage and reason
   with an _unknown_ target — expect "8 of 20 iterations failed first at `call`
   (toolError)" with no tool named. The miner already supports the sampled
   exemplar path (`toolFailureBasis: 'sampled'`), but the live loader does not
   perform it yet. **Biggest gap.**
4. **The combined (multi-run) view has no findings section.** A snapshot
   describes one run; one section per run would mean one subscription and one
   generation controller each. Noted in `combined-run-content.tsx`.
5. **Evals only.** Swarms and User Testing are untouched by design. The shared
   components are shaped to serve them if this survives.
6. **The old presentation is still mounted below the new one.** Intentional for
   this branch — it is how you compare. A production cutover removes one of
   them and the flag with it.
7. **The preview's state buttons simulate props, not data.** They cannot show
   you a real build failing; that needs §5.

---

## 10. Morning checklist

1. `npm install --legacy-peer-deps` here; `npm install` in the backend worktree.
2. Backend: `npm run findings:replay -- --fixtures --mock-enrichment --out /tmp/unified-findings-replay.json`
3. Here: `npm run findings:preview -- --replay /tmp/unified-findings-replay.json` → http://localhost:5175
4. Work §8 step 1 (offline). That alone answers the deterministic half.
5. Optional: §5 + §8 steps 2–4 on a **dev** deployment.
6. `npm run check:findings-wire-parity -w @mcpjam/inspector -- --backend ../mcpjam-backend-findings`
   if you want the cross-repo contract confirmed on your machine.
