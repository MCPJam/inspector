---
"@mcpjam/inspector": patch
---

Turn MCPJam's pull-request comments off per repository, and say at connect time that they exist

MCPJam now posts one comment on each pull request in a connected repository and
updates that same comment in place on every later push. The check run already
said the same thing; the comment says it where a person — or a coding agent —
reading the pull request will actually find it. That makes it a write on
somebody else's repository, so this adds the two things a write like that owes
an administrator: a way to stop it, and a sentence before it starts.

**Settings → Integrations → GitHub** gains a per-repository **Post feedback
comments on pull requests** toggle, and the connect section now says MCPJam will
comment before you click Connect rather than after.

**Absent means ON, and reading it the ordinary way would have misreported every
repository.** `feedbackComments` inverts the default that every other optional
policy on the row follows: a comment blocks nothing, so it ships on for every
connected repository including the ones connected before it existed, and an
admin opts a repository OUT. `conformanceEnabled` beside it is absent ⇒ off for
the opposite reason — that one adds a check, and growing a required check under
a maintainer without asking is a merge-blocking surprise. A control that treated
the two the same would render OFF for every untouched row, which today is all of
them, and tell an administrator the opposite of what is happening on their pull
requests. The switch reads `!== "off"` and the flip derives from the same rule,
so the first click on an untouched row turns comments off rather than appearing
to do nothing.

The toggle is deliberately NOT gated on the row's enable switch, unlike
conformance: this decides what MCPJam may WRITE, and a repository whose checks
are paused is still one an admin may want to settle that for.

Its writes get their own pending set — three different writes now land on one
row, and a shared set would grey out a control nobody has touched. Success is
announced, unlike the outage-policy select, because turning comments off is the
setting an admin reaches for while worried about what MCPJam is publishing, and
the useful half of the answer is the half about the check: it still runs and
still reports. A refusal is shown exactly as the backend worded it, with a
comment-specific fallback only for a failure that carried no message —
"nothing changed" is worth saying about a write with this consequence.

Docs: a new **GitHub Checks** page covers the `mcpjam.yaml` recipe, the comment
and its machine-readable JSON block, the review comments MCPJam leaves on a
removed tool name — a location, never a cause, and never a requested change —
and exactly what may and may not appear on a public pull request. The Settings
page's "Read the docs" link pointed at it before it existed. `cloud eval checks
connect` in the CLI reference now names the comment too, since that command
connects a repository without ever showing the settings page.
