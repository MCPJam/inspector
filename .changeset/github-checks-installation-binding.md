---
"@mcpjam/inspector": minor
---

Connect GitHub accounts to a workspace, and say when a connected repository is
not actually ready.

Needs the matching backend deployment: until it lands, the account and
binding functions this surface calls do not resolve.

GitHub Checks used to assume one GitHub App installation for the whole
deployment, so the settings page had nothing to say about WHICH account a
repository came from — there was only ever one. That is changing on the backend,
and this is the surface for it.

Settings → Integrations → GitHub now has a **GitHub accounts** section. Install
the app on an account from here, or _claim_ an installation somebody already
added from GitHub's side. Claiming asks you to sign in to GitHub, and the copy
says why: installing the app is not on its own proof that an installation is
yours to connect to this workspace, so the backend requires a GitHub user
authorization that names you as someone who administers that account.
Disconnecting asks for confirmation, and the confirmation says what is KEPT as
well as what stops — your suite and policy choices survive, so reconnecting is
not a rebuild.

Connected repositories now carry a state when something is wrong: **Reconnect
required**, **App inactive**, or **No access**. Each one names what happened and
rules out the reading that would send you to fix the wrong thing — three of the
four states have nothing to do with your code, and the natural assumption when a
check stops is that it does. A healthy row gets no badge at all. The state is
decided by the backend; it is never inferred from a missing visibility badge,
which means "GitHub did not tell us", not "something is wrong".

The repository picker now aggregates every connected account and selects by
GitHub's numeric repository id rather than by name — two accounts can each have
a `widgets`, and a name is not an identity. The account is shown beside a
repository only when it disambiguates.

A repository conflict, an installation already connected to another workspace,
or a failed proof all read exactly as the backend worded them, and none of them
names another workspace.
