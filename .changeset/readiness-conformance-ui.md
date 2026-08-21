---
"@mcpjam/inspector": minor
---

Directory readiness on the /conformance page

Two new sections — Claude and OpenAI — beside the Protocol, Apps, Tasks and
OAuth suites, behind the `mcpjam-directory-readiness` flag. The engine, the
API and the local route already existed; this is the first surface that calls
any of them.

**Each section owns its run.** They are deliberately outside the page's shared
"Run available checks" button: a hosted readiness run takes minutes, and
joining the shared busy state would hold that button and the protocol-version
selector hostage for its duration. They are also outside the pooled score,
because readiness produces lanes and coverage rather than passed and failed
checks — there is no number to pool, by design.

**Two execution modes behind one control.** Locally the run is synchronous and
free, and cannot spend: the route has no observations flag at all. Hosted, it
is a durable run — `202`, poll, cancel, and a report fetched lazily when
somebody opens the findings, because it can be megabytes. A reload mid-run
finds its way back to the run still going, which no other suite on the page
can do.

**The three axes stay apart.** Whether the run finished, what it graded, and
whether the optional paid pass ran are three different answers. A run that
FAILED shows "Run failed" rather than "not ready" — our runner falling over is
not a finding about somebody's server. A refused AI observation renders as a
gap with the reason, never as a failure, because `billing_limit_reached` means
"we could not afford to look" and the deterministic grade is complete without
it.

**Coverage travels with every verdict.** A lane prints what it evaluated out of
what it selected, states `not applicable` separately from `not evaluated`, and
names the input that would close its gap. Findings group by class in the order
somebody fixes them — blockers, requirements, recommendations, human review,
observations — because the class is what decides whether a finding moved the
verdict, and a model-authored line is labelled as one.

**The two package submission modes are offered but disabled**, with the CLI
command that can run them. They need bytes on the developer's machine, and a
shorter menu would teach a submitter that readiness cannot grade their plugin
at all.

The hosted routes needed the user's bearer, and their scope sits in the middle
of the path so no prefix could name them. Rather than allowlisting all of
`/api/v1/projects/` — which would hand the bearer to every project-scoped
public route that ever ships — `HOSTED_AUTH_PATH_PREFIXES` gained a sibling
pattern list, anchored at both ends, with tests covering the six paths that
must carry it and six neighbours that must not.
