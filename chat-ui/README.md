# @mcpjam/chat-ui

A reusable, **read-only transcript renderer** for AI SDK-style chat messages
(`UIMessage`). Renders text, reasoning, files, sources, JSON/data parts,
approvals-as-state, and tool call/result blocks.

This is **Tier A**: it does **not** render MCP Apps widgets. Widget-bearing tool
calls render a deterministic placeholder (or are hidden). It has **zero runtime
imports** from Convex, PostHog, inspector stores/state/contexts, the MCP Apps
renderer, sandbox/iframe code, or widget replay — enforced by
`scripts/check-no-tier-b-imports.mjs`.

## Install

```bash
npm install @mcpjam/chat-ui
```

Peer deps: `react`, `react-dom`, `ai`, `@ai-sdk/react`.

## Usage

```tsx
import { ReadOnlyTranscript } from "@mcpjam/chat-ui";
import "@mcpjam/chat-ui/styles.css";

export function Transcript({ messages }) {
  return (
    <ReadOnlyTranscript
      messages={messages}
      model={{ id: "gpt-5", name: "GPT-5", provider: "openai" }}
      reasoningDisplayMode="collapsed"
      widgetPolicy="placeholder"
      themeMode="system"
    />
  );
}
```

### `ReadOnlyTranscript` props

| Prop                   | Type                                            | Default                                            |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------- |
| `messages`             | `UIMessage[]`                                   | —                                                  |
| `model`                | `ChatUiModel`                                   | `{ id: "unknown", name: "Unknown", provider: "custom" }` |
| `toolsMetadata`        | `Record<string, Record<string, unknown>>`       | `{}`                                               |
| `toolServerMap`        | `Record<string, string>`                        | `{}`                                               |
| `toolRenderOverrides`  | `Record<string, ToolRenderOverride>`            | —                                                  |
| `themeMode`            | `"light" \| "dark" \| "system"`                 | `"system"`                                         |
| `reasoningDisplayMode` | `"inline" \| "collapsible" \| "collapsed" \| "hidden"` | `"inline"`                                  |
| `widgetPolicy`         | `"placeholder" \| "hidden"`                     | `"placeholder"`                                    |
| `className`            | `string`                                        | —                                                  |
| `showAssistantAvatar`  | `boolean`                                       | `Boolean(renderAvatar)`                            |
| `renderAvatar`         | `(model) => ReactNode`                          | —                                                  |

### Host integration (interactive embedders)

`ReadOnlyTranscript` is fully static. Hosts that need interactivity (e.g. the
MCPJam inspector) use the lower-level `Transcript` and inject seams — keeping
the package free of their wiring:

- `renderTool(ctx)` — render your own interactive tool block (save-view,
  display-mode controls, etc.) instead of the static `ToolCallPart`.
- `renderWidget(input)` — mount a real widget surface instead of the placeholder.

```tsx
import { Transcript } from "@mcpjam/chat-ui";

<Transcript
  messages={messages}
  renderWidget={(input) => <MyWidget {...input} />}
  renderTool={(ctx) => <MyInteractiveToolPart {...ctx} />}
/>;
```

## Styling

The renderer uses shadcn-style semantic utility classes
(`text-muted-foreground`, `bg-card`, `border-border`, …). Consumers need a
Tailwind v4-compatible utility layer. `@mcpjam/chat-ui/styles.css` ships the
token *values* (scoped to `.mcpjam-chat-ui`) with light/dark defaults; override
any `--token` to theme.

> A fully self-contained compiled CSS bundle (so consumers don't need their own
> Tailwind) is a planned follow-up.

## Scope

Tier A is read-only transcript review. Full MCP Apps widget replay (sandbox
origin, CSP, security review) is a separate Tier B effort.

## Which renderer to use (BB-239)

MCPJam has two message renderers and needs both. What it does not need is for
them to look like two products, which is what happened to Sessions: a generic
chat bubble in front of every response and monochrome JSON, beside a Playground
that had neither.

**The boundary is the provider graph, not read-only vs. interactive.** The
inspector's renderer (`mcpjam-inspector/client/src/components/chat-v2/thread.tsx`,
via `thread/transcript-thread.tsx`) is built on inspector stores, contexts and
the widget runtime. Use it on any surface that has them:

- `components/ui-playground/PlaygroundMain.tsx` and `multi-model-playground-card.tsx`
- `components/ChatTabV2.tsx` and `chat-v2/multi-model-chat-card.tsx`
- `components/mcpjam-agent/McpjamAgentThread.tsx`
- `components/evals/trace-viewer.tsx` — **read-only, and still on this
  renderer.** It replays a finished trace but keeps a live seam
  (`interactive={threadInteractive}`) for sending a follow-up from the trace.
  Being read-only is not by itself a reason to move a surface here.

Use `@mcpjam/chat-ui` where that graph is absent or unwanted — a transcript that
must render with no Convex, no stores, no analytics and no side effects:

- `connection/share-usage/ShareUsageThreadDetail.tsx`, which is what Sessions
  (User Testing and Swarm) and Scenarios all render
- `connection/share-usage/session-scored-transcript.tsx`
- any embedder outside this repo

Before forking a third renderer, note that `renderTool`, `renderWidget`,
`renderTurnFooter` and `renderAvatar` exist so a host can change one piece
without owning the whole transcript.

Where the two must agree visually, **the agreement lives in shared code rather
than in matching CSS**, because matching CSS is what drifted:

- **JSON colouring** — one tokenizer, `chat-ui/src/internal/json-tokens.ts`,
  published as `@mcpjam/chat-ui/json-tokens`. The inspector's
  `client/src/components/ui/json-editor/json-syntax-highlighter.ts` re-exports
  it, so the Playground's `JsonEditor` and this package's `JsonView` colour a
  payload from the same token stream, under the same class names.
- **No generic assistant avatar** — `showAssistantAvatar` defaults to whether
  `renderAvatar` was supplied, so neither renderer draws a placeholder nobody
  asked for.

Deliberate differences that are **not** drift: this package never mounts a
widget, never edits a payload (the Playground's `JsonEditor` is CodeMirror and
writable; `JsonView` is a `<pre>`), and folds large tool results by default
because a review surface is read top-to-bottom while a live chat is watched.

Paths above are repo-root-relative. This file lives in a different workspace
from most of them, so a rename on the client side will not prompt an edit here
— they are written to be greppable rather than resolvable.
