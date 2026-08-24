---
"@mcpjam/inspector": minor
---

Evaluate gets a real landing page, and creating a suite is a page instead of a modal.

**`/evals` used to have no list.** Landing there ran an effect that picked the most recently *run* suite and `replace`d the URL with its dashboard, so the only way to see what suites existed — or to reach one that had never run, which ties with every other never-run suite — was the breadcrumb's suite dropdown. The bare list route survived solely as the empty state. That redirect is gone: the landing now renders `SuitesOverview` (one row per suite, sorted by latest activity, with inline Run/Cancel) behind a **Suites | Runs** switcher in the header, where Runs is the existing project-wide `ProjectRunsTable`. Rows use the same pad and column template as User Testing's scenario list so the two landings read as one product.

**`CreateSuiteDialog` is now `CreateSuitePage`** at the `/evals/create` route the dialog was already opening. Mutation, payload shape, and post-create navigation are unchanged and still owned by `EvalsTab`; the page owns chrome, prefill, and the environment lego strip. Two things the modal could not do:

- **The name field seeds with a real default** (`Customer support workflows`) rather than empty, so Continue is enabled on first paint. An empty-hero, URL, or agent prefill still wins, and clearing the field falls back to the seed as placeholder.
- **The empty hero offers your connected servers directly** — up to four, since more wraps badly under the subtitle. Picking one prefills both the suite name and the server group, resolved by `pickServerAttachmentIdForServer`: an exact single-server group if one exists, otherwise the *smallest* group containing that server, and `null` when nothing matches so a card can never silently attach a different server's group.

**A suite's overview page is new**, not a re-skin. `SuiteDetailOverview` renders an identity line (`N cases · N sources · N servers`, where sources are the distinct run origins — UI, SDK, API, scheduled, GitHub), a filterable and paged run-history table, and the case list, with the empty-case state offering Describe / Generate / Import. Its arithmetic lives in `suite-detail-model.ts` as pure functions with their own tests, rather than inline in the view. Run *detail* is untouched and still folds into `SuiteDashboard`.

**The header is one component across both eval surfaces.** `EvalsHeader` now owns the Evaluate title, description, Create suite button, and the landing tabs; detail routes swap that chrome for an `Evaluate / suite / page` trail. CI Evals renders the same header and its hand-rolled breadcrumb — with its own commit-crumb bookkeeping — is deleted, as is `evals-mode-nav.tsx`. Because the header sits above `EvalTabGate`, the title and Create suite stay on screen while auth and project selection settle instead of appearing after a spinner.

The agent-facing `ui_open_eval_suite_form` tool is unchanged in behavior — still name-only, prefill-over-commit, still opening `/evals/create` — and only its wording moves from "dialog" to "page".
