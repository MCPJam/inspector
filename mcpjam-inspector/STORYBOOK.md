# Storybook

A gallery of components, running on their own with no app around them. Each entry
is a **story**: one component in one state, rendered in isolation so you can look
at it and poke it without clicking through the product to reproduce the state.

The first thing in here is **Error Patterns**: the four surfaces that carry
errors in MCPJam, each with a before/after, plus a proposal page on severity
and copy.

## Running it

```bash
npm install --legacy-peer-deps
```

```bash
npm run storybook -w @mcpjam/inspector
```

Opens on <http://localhost:6006>. Saving a story reloads the preview; edits
to `.storybook/main.ts` need a restart.

Use the Node version in `.nvmrc` (24.22.1).

## Why it lives here and not in design-system

Three of the four error patterns are app components: `ErrorCard`, the `toast`
wrapper, and the full-page error screens. The design system cannot import them:
the app depends on `@mcpjam/design-system`, so importing back the other way is a
dependency cycle.

A Storybook in the design system could therefore only show replicas of them, and
a replica drifts from the product and starts quietly lying. From here stories
can import the real components, including the design system's own by its
published path (`@mcpjam/design-system/field-error`). Not every specimen is real
yet: the Overview page lists which are real components and which are drawn.

## What you're looking at

Top-left is the sidebar of stories. Above the canvas:

- **Theme** — light/dark. The design system defines both and DESIGN.md asks for
  them to be designed together, so check both before calling something done.
- **Viewport / zoom** — the icons to the right.
- **Docs** — on a page with an `.mdx` file, the open-book icon shows the prose.

## The files, and why each exists

| File | What it does |
| --- | --- |
| `.storybook/main.ts` | Where the stories are, which features are on, how the dev server resolves imports. |
| `.storybook/preview.tsx` | Everything wrapped around every story: the theme switch and the mounted toast host. |
| `.storybook/preview.css` | Imports the app's real stylesheet, then undoes three app-shell rules. |
| `tsconfig.storybook.json` | Typechecks `stories/` and `.storybook/`, which `typecheck:client` doesn't cover. |
| `stories/**/*.stories.tsx` | The stories themselves. |
| `stories/**/*.mdx` | Prose pages. |

Three things worth knowing, because they'll bite otherwise.

**Tailwind v4 has no config file.** The configuration *is* CSS — the `@theme` and
`@custom-variant` blocks in `design-system/src/tokens.css` and
`design-system/src/index.css`. So "use the Tailwind config" means importing those
stylesheets, not pointing at a `tailwind.config.js`. There isn't one.

**`preview.css` imports `client/src/index.css` directly.** Not a copy — the real
thing, so there is nothing to drift. It then has to undo `height: 100%` and
`overflow: hidden` on `html`/`body`, which the app sets so its own panes own all
scrolling; inherited into Storybook they make every tall story and docs page
unscrollable.

**`main.ts` reuses the client's Vite config for `resolve` only.** That's where
`@/lib/clipboard`, `@mcpjam/sdk/browser` and about twenty other aliases come
from, and restating them would reproduce the drift problem one layer down. Its
plugin chain is deliberately *not* reused — Sentry, PostHog source maps and
telemetry catalog generation belong to a production build, not a gallery.

## Adding a story

Make a file in `stories/`, ending in `.stories.tsx`. The smallest useful one:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "@mcpjam/design-system/badge";

// `title` is the sidebar path — slashes make folders.
const meta = {
  title: "Primitives/Badge",
  component: Badge,
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

// Every named export is one story. The sidebar name comes from the export name
// unless you set `name`.
export const Default: Story = {
  args: { children: "Connected" },
};

export const Destructive: Story = {
  args: { children: "Failed", variant: "destructive" },
};
```

That's the whole contract: a default export describing the component, and one
named export per state.

When a story needs more than props — two things side by side, a wrapper, an
effect — use `render` instead of `args`:

```tsx
export const Comparison: Story = {
  render: () => (
    <div className="flex gap-2">
      <Badge>Connected</Badge>
      <Badge variant="destructive">Failed</Badge>
    </div>
  ),
};
```

One gotcha: if `meta` names a `component` whose props are required, Storybook
makes `args` mandatory on every story. When you're composing a whole surface
through `render` instead of driving one component by its props, leave
`component` out. `03-error-card.stories.tsx` does this and says why.

### Conventions in this folder

- **Import app components by their alias** (`@/components/ui/error-card`) and
  design-system components by package path (`@mcpjam/design-system/button`).
- **Import `toast` from `@/lib/toast`**, never from `sonner` — the wrapper is
  what gives error toasts their longer duration and copy button.
- **Show a before and an after**, using `BeforeAfter` and `Panel` from
  `stories/error-patterns/_support/layout.tsx`. Showing only the fixed version
  teaches the shape but not the reason, and the reason is what transfers.
- **The before must be visible without clicking.** An earlier draft put a button
  in the before column and a caption saying "press this to see the error", which
  made the comparison useless to anyone scrolling. Use `useToastSpecimen` from
  `_support/specimens.tsx` to raise a real toast on mount.
- **Annotate against the rules.** `Panel` takes a `broken` array; each entry
  names the check that fails and why. `✗` on a before, `✓` on an after.
- **A file that isn't `.stories.tsx` isn't picked up** — that's why helpers live
  in `_support/`.

### Writing an `.mdx` page

Plain markdown plus a `<Meta>` at the top:

```mdx
import { Meta } from "@storybook/addon-docs/blocks";

<Meta title="Error Patterns/Overview" />

# My page
```

Tables work because `remark-gfm` is switched on in `main.ts`. Without it they
render as literal pipe characters, silently — no warning, no console error.

## Before you commit

```bash
npm run typecheck:storybook -w @mcpjam/inspector
```

Vite strips types rather than checking them, so Storybook will happily boot a
story that doesn't compile. This is the check that catches a story gone stale
against the component it documents.

## Writing the error copy itself

This Storybook shows which *surface* to use. For the words:

- **The Errors checks drafted for DESIGN.md** (shared in Slack, not yet merged
  into the file) — the four checks (E1 plain language, E2
  precisely indicates the problem, E3 offers a way out, E4 consistent).
- **The `ui-copy` skill** — reviews or rewrites a user-facing string against the
  same rubric CI runs. Worth running over new error copy before a PR.

Where an error has a real diagnosis it belongs in
`sdk/src/error-describer/catalog.ts` rather than as a new string at the call
site — the catalog's schema (title, explanation, causes, next steps, docs
anchor) is E1–E3 expressed as code.
