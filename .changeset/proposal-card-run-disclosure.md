---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Carry the pre-run disclosure on the agent's run proposal cards (Evals v2, Lane
G, step G4d).

G4b/G4c disclose a run to the person who LAUNCHES it. A proposal is the one
place where that is not the same person: the agent picked the suite, and
someone else is about to click "Run it" on a card in Slack with nothing in
front of them but a one-line description and a spend warning. This puts the
same facts on that card.

- `@mcpjam/sdk/public-api`: `ProposedAction` gains an additive `disclosure?`
  (`ProposedActionDisclosure`) — engine, sandbox, the providers the run's own
  models reach, the judge providers it does NOT already reach, retention, and
  a BYOK flag, plus the `digest` that joins the summary back to the full
  contract. Deliberately small: an approval card states what a person did not
  choose and cannot infer, and links the rest by digest.
  `get_eval_run_disclosure` still serves the whole payload for a host that
  wants it.
- `POST /v1/projects/{projectId}/agent`: the two eval-run proposals declare a
  `carriesDisclosure` hook in the op registry, and `persistProposal` fetches a
  disclosure for the FROZEN input — the same object the click will execute —
  through `get_eval_run_disclosure`, so what was disclosed is what will run
  rather than a second, independently resolved target. Going through the
  operation is what keeps the runner-capability handshake, the composed
  `execution.locus` and the recomputed digest at ONE site instead of two.
- The Slack bot renders one line per disclosed proposal, in the same wording
  register as the app's own run-disclosure hint.

Three properties this had to have, and one honest limit:

1. **One resolution.** Never re-resolved from raw selectors. `allAttached`
   re-expands against whatever is attached at the time, so a disclosure
   derived from it could describe a set the click does not run — the freeze
   already drops it, and an input where it survived is refused rather than
   disclosed.
2. **Best-effort, independently bounded.** Its own 3s timeout, its own
   try/catch, skipped entirely without a client. A timeout, a transient error,
   or a backend predating the contract (`422 FEATURE_NOT_SUPPORTED`) leaves
   the field absent and mints the proposal exactly as before. Logged at info,
   because an absent disclosure is a designed outcome of this path, not a
   fault.
3. **Absence is unknown, never safe.** Nothing substitutes a reassuring
   default for a fact it could not obtain: no engine rather than "emulated",
   no sandbox clause rather than "no sandbox", no provider list rather than an
   empty one. `runProviders` is all-or-nothing (a model that declined
   classification omits the whole list rather than naming fewer destinations
   than the run reaches), and a compose run or a multi-target host group is
   refused outright — the suite-base derivation those would fall back to is
   the exact "emulated, no sandbox moments before a harness booted" failure
   G4c refused for the host axis.

**The limit:** this describes the plan as of the MINT, the same guarantee the
proposal's `description` already carries. An attachment edit between the mint
and the click is not re-disclosed here; the launch receipt's own disclosure
(`run_eval_suite`'s `onDisclosure`) stays the authoritative at-click answer.
The disclosure is envelope data only — it is not persisted with the proposal
and is never accepted back from a host, because the click executes from the
stored input and a disclosure that round-tripped would be a claim the host
could author.

No backend change and no deploy coupling: against a deployment predating the
contract the fetch fails and the field is simply absent, which is the designed
degrade.
