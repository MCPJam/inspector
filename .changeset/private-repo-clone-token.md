---
"@mcpjam/inspector": patch
---

Clone private repositories for GitHub PR checks, using a short-lived
installation token that never touches disk.

A claim now carries `repoPrivate`. When it is true — and only then — the worker
asks the backend's `/internal/v1/github-checks/clone-token` route for a
repository-scoped `contents: read` installation token and threads it to the
clone. Public repositories are cloned anonymously, byte-for-byte as before, and
never call the route at all: minting a credential nothing needs is blast radius
bought for nothing.

The ordering is load-bearing in both directions. The token is minted **after**
`/plan/begin` and **before** the first sandbox is provisioned, so a mint failure
is reported as an ordinary ladder-level `clone` / `clone_failed` attempt on a
plan that already exists — attributable, countable, and `infra_error` rather than
the pull request's fault — instead of needing the planless completion path. A
`409` means this worker no longer holds the claim: the check is abandoned with no
competing completion and no box provisioned, and a `502` or a null token for a
private repository are the same `clone_failed` result, because an anonymous
retry would 404 and read as the repository having vanished.

Where the credential goes is deliberately narrow. It rides on a command-line
`git -c 'http.extraheader=AUTHORIZATION: basic <base64>'` for the clone and the
fetch, and nothing else — not the checkout, not `rev-parse`, not the build. The
URL stays the ordinary `https://github.com/owner/repo.git`, because a credential
in the URL is written verbatim into `.git/config`, which is a file the pull
request's own build would then be able to read. No credential helper, no
environment variable, no file, and nothing persisted: `-c` is process-scoped, and
clone and fetch both finish before any PR-controlled process runs.

A new `redactCloneCredential` boundary removes the raw token, the
`base64(x-access-token:<token>)` it is sent as, and any whole
`AUTHORIZATION: basic …` header from every observable failure — a non-zero git
exit, a deadline overrun, and in particular a thrown transport error, since an
SDK error quotes the command it was running and that command carries the header.
Redaction runs _before_ clamping, because clamping is a length and markdown
boundary rather than a secret one. Token-derived values are removed by literal
replacement, never by a pattern built from the token.
