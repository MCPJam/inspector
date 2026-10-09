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

**Pick by whether the inspector's provider graph is available.** Its renderer
(`mcpjam-inspector/client/src/components/chat-v2/thread.tsx`, via
`mcpjam-inspector/client/src/components/chat-v2/thread/transcript-thread.tsx`)
is built on inspector stores, contexts and the widget runtime. Use it on any
surface that has them:

- `mcpjam-inspector/client/src/components/ui-playground/PlaygroundMain.tsx`
- `mcpjam-inspector/client/src/components/ui-playground/multi-model-playground-card.tsx`
- `mcpjam-inspector/client/src/components/ChatTabV2.tsx`
- `mcpjam-inspector/client/src/components/chat-v2/multi-model-chat-card.tsx`
- `mcpjam-inspector/client/src/components/mcpjam-agent/McpjamAgentThread.tsx`
- `mcpjam-inspector/client/src/components/evals/trace-viewer.tsx` — **read-only,
  and still on this renderer.** It replays a finished trace but keeps a live
  seam (`interactive={threadInteractive}`) for sending a follow-up from it.
  Being read-only is not on its own a reason to move a surface across.

- `mcpjam-inspector/client/src/components/connection/share-usage/ShareUsageThreadDetail.tsx`
  and `session-scored-transcript.tsx` use `TraceViewer` for Sessions, User Testing,
  Swarms and Scenarios. They preserve ratings and use static widget placeholders.

Use `@mcpjam/chat-ui` where that graph is absent or unwanted, such as an external
embedder that needs no Convex, stores, analytics or widget runtime.

Before forking a third renderer, note that `renderTool`, `renderWidget`,
`renderTurnFooter` and `renderAvatar` exist so a host can change one piece
without owning the whole transcript.

Where the two must agree visually, **the agreement lives in shared code rather
than in matching CSS**, because matching CSS is what drifted. In order of
preference:

- **Hand the host's own component through a seam.** `renderJson` lets an
  embedder supply its own JSON tree without forking the transcript.
- **Share the primitive underneath.** One tokenizer,
  `chat-ui/src/internal/json-tokens.ts`, published as
  `@mcpjam/chat-ui/json-tokens` and re-exported by the inspector's
  `mcpjam-inspector/client/src/components/ui/json-editor/json-syntax-highlighter.ts`.
  This is what colours `JsonView`, the default a host gets when it passes no
  `renderJson` — an embedder outside this repo, mostly.
- **Share the default.** `showAssistantAvatar` defaults to whether
  `renderAvatar` was supplied, so neither renderer draws a placeholder nobody
  asked for.

Deliberate differences that are **not** drift: this package never mounts a
widget, and never edits a payload — the Playground's `JsonEditor` is CodeMirror
and writable, while `JsonView` is a `<pre>`.

Paths above are repo-root-relative, so they resolve. This file still lives in a
different workspace from most of them, so a client-side rename will not prompt
an edit here; if one looks stale, grep for the basename.
