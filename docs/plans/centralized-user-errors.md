# Centralized Inspector error messages

## Where to edit

`mcpjam-inspector/client/src/lib/error-messages.ts` is the copy catalog:

- `ERROR_MESSAGES`: fixed messages for operations, local validation and error screens.
- `ERROR_MESSAGE_TEMPLATES`: contextual messages with explicit display-name or count arguments. Never pass backend error text into these arguments.

`mcpjam-inspector/client/src/lib/user-error.ts` selects user guidance. It accepts
only catalog strings or explicitly mapped backend codes. Unknown failures and
unregistered fallback strings resolve to the generic catalog message. For an
operation-specific fallback:

```ts
getUserErrorMessage(error, ERROR_MESSAGES.failedToCreateSuite)
```

Classify errors using the original value before formatting them. Keep structured
status/code objects intact for authentication, billing and retry logic. Raw
technical evidence belongs in logging or an explicit diagnostic disclosure, not
the primary error sentence. Server connection toasts retain the server name and
protocol-version recovery action while replacing backend prose.

The catalog test prevents new static messages in toast and inline error setters.
Tests also cover unknown payloads, known codes, unsafe fallback arguments,
page-error privacy, connection recovery and retention of editable form state.

## Current increment

- [x] Extract static operation messages without changing their behavior first.
- [x] Add a catalog-only resolver and migrate Convex, ordinary error catches, route crashes, connection toasts and unknown error-card guidance.
- [x] Centralize contextual toast templates and remove interpolated backend failure text.
- [x] Clarify unknown failures, session startup, GitHub recovery and OAuth connection failures.
- [ ] Finish the full app-wide coverage audit. Specialized JSX banners, remaining domain formatting helpers (including billing), and dynamic inline error-state producers still need migration. The current catalog is not yet an exhaustive inventory of every string the app can display.
- [ ] Complete the editorial review of all extracted copy. The extraction intentionally retains most existing wording for reviewable increments.

SDK/CLI error catalogs and raw MCP/tool diagnostic output are outside this initial
Inspector increment. The original checkout and its unrelated changes are untouched.

## Validation limitations

The original checkout's dependency installation is reused via a worktree-local
`node_modules` symlink. An untouched `origin/main` archive with the same dependency
installation reproduces six SDK type errors and 21 client-test failures across
three files when run from the Inspector package directory. The standard inspector pretest also cannot resolve
`@ai-sdk/harness/bridge`; the direct client Vitest command is used for regression
coverage. `design:check` passes; `design:lint` cannot start because `designmd` is
not installed in this environment. No passing status is claimed for blocked checks.

The catalog currently holds 710 fixed strings and 21 contextual templates. The
full client run exercised 16,348 tests. Its seven additional copy-expectation
failures were corrected and the affected two files reran successfully (120/120).
The remaining 21 failures reproduce on untouched main. The catalog/resolver and
billing/GitHub-focused run passed 68 tests; presentation-focused tests cover
backend fallbacks and protocol-version recovery. No live-browser check was run.
