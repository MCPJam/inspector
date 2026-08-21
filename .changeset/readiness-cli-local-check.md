---
"@mcpjam/cli": minor
---

`mcpjam readiness check` — grade a connector or plugin locally

Two of OpenAI's four submission shapes carry a PACKAGE, and a package is bytes
on the developer's disk: there is no upload for it, deliberately, so those
shapes can only ever be graded here. Anthropic's intrusive probes are the same
story from the other side — they register an OAuth client on the target, which
is a thing to do to a server you own from a machine you control, not something
a hosted worker should do on somebody's behalf.

So this is not the offline fallback for the hosted endpoints. It grades what
only the developer's machine can reach; the hosted commands grade the server as
the PLATFORM reaches it, and the two answers are worth having separately.

**The mode is declared, never inferred.** `--submission-mode` is required for
OpenAI, and the per-mode input rules are usage errors rather than silent
adjustments: a wire mode refuses `--package`, a package mode refuses a URL,
and either refuses to run without the input its shape requires. Inferring
would read a forgotten `--package` as `mcp-only`, report the package lane
`not-applicable`, and hand a submitter a clean bill of health for an artifact
nobody looked at. The rules are read off `OPENAI_SUBMISSION_MODE_SHAPES`, so a
fifth mode cannot arrive with this command quietly accepting the wrong inputs.

`--package` takes a directory or a `.zip`, decided by what is on disk rather
than by suffix — someone pointing at the folder they are about to zip should
get the same grade as someone pointing at the archive. A directory reports the
archive-shaped checks as gaps rather than inventing answers, because it is not
an archive yet; a zip closes them by reading the RAW central directory before
the zip library normalizes it, since `..`, backslashes and duplicate names are
exactly what the portal rejects and a repairing loader would hide.

Exit codes match every other gate here — `0` ready, `1` not-ready, `3`
incomplete, `2` usage — with a `directoryReadinessExitCode` of its own rather
than a reuse of `conformanceExitCode`, whose `{passed, outcome}` shape would
read an incomplete readiness run as a violation. No infrastructure condition
maps to `1`.

Output follows the same channel discipline as `protocol conformance`: stdout
carries only the result (`--reporter json-summary|junit-xml` work today, since
the report providers already know both readiness kinds), while the verdict and
the gap list go to stderr, are suppressed by `--quiet`, and never affect the
exit code. The gap list names the input that would close each lane, because an
`incomplete` verdict without the next action is an adjective rather than an
answer.
