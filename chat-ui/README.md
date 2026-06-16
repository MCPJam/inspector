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
