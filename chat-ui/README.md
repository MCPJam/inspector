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
| `showAssistantAvatar`  | `boolean`                                       | `false`                                            |
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

## Which renderer is canonical (BB-239)

MCPJam has two message renderers, and it needs both. What it does not need is
for them to look like two products, which is what happened to Sessions: a
generic chat bubble in front of every response and monochrome JSON, next to a
Playground that had neither. The rule that keeps them together:

| Surface                                                       | Renderer                                     |
| ------------------------------------------------------------- | -------------------------------------------- |
| **Live, interactive chat** — Playground, Chat                  | `chat-v2/thread/transcript-thread.tsx`       |
| **Read-only transcripts** — Sessions (User Testing and Swarm), Scenarios, shared threads, any future review surface | `@mcpjam/chat-ui` `ReadOnlyTranscript`       |

The split is about *interactivity*, not about which team owns the screen. A new
surface that replays a finished conversation uses `ReadOnlyTranscript` — there
is no case for a third renderer, and "ours needs one small thing different" is
what `renderTool` / `renderWidget` / `renderTurnFooter` / `renderAvatar` exist
for.

Where the two must agree visually, **the agreement lives in shared code rather
than in matching CSS**, because matching CSS is what drifted:

- **JSON colouring** — one tokenizer, `internal/json-tokens.ts`, exported as
  `tokenizeJson`. The inspector's `ui/json-editor/json-syntax-highlighter.ts`
  re-exports it, so the Playground's `JsonEditor` and this package's `JsonView`
  colour a payload from the same token stream. The class names
  (`json-key`, `json-string`, …) are shared too, so a transcript embedded in the
  inspector inherits the app's palette.
- **No generic assistant avatar** — `showAssistantAvatar` defaults to `false`,
  matching `transcript-thread.tsx`, which has never drawn one. A host with a
  real identity to show opts in and supplies it through `renderAvatar`.

Deliberate differences that are **not** drift: this package never mounts a
widget, never edits a payload (the Playground's `JsonEditor` is CodeMirror and
writable; `JsonView` is a `<pre>`), and folds large tool results by default
because a review surface is read top-to-bottom while a live chat is watched.
