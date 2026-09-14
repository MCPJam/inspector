import { JsonTreeView } from "@/components/ui/json-editor";
import type { JsonRenderer } from "@mcpjam/chat-ui";

/**
 * How a session transcript shows a tool's input and output.
 *
 * THE PLAYGROUND'S VIEWER, not a second one that looks like it. `JsonTreeView`
 * is the same component the Playground's tool card puts payloads in, reached
 * through `@mcpjam/chat-ui`'s `renderJson` seam because the transcript renderer
 * is a published package the inspector depends on, so it cannot import a tree
 * that lives in the inspector.
 *
 * What a reader gets that the package's `<pre>` could not give them: objects
 * and arrays collapse, a deep payload opens two levels and stops, long strings
 * truncate with a control to see the rest, and every node has its own copy
 * button — so pulling one id out of a tool result is a click rather than a
 * select-and-trim.
 *
 * ## Why these three settings
 *
 * `defaultExpandDepth={2}` matches the Playground exactly. It is also the
 * setting that makes this readable inside a transcript: the top level and its
 * immediate children open, and everything below arrives as `{ n keys }` the
 * reader can open if they care.
 *
 * `collapseStringsAfterLength` is NOT set, so the tree's own default applies —
 * the same one the Playground gets. A session-specific number here would mean
 * two surfaces disagreeing about how long is too long for one string.
 *
 * No `height` / `maxHeight`. In the Playground this sits in a fixed pane and
 * is told to fill it; here it sits inside a `FoldedBlock` in a scrolling
 * transcript, and a viewer with its own scrollbar inside a page with one is
 * the thing people mean by nested scroll.
 *
 * ## The fold stays
 *
 * This renders INSIDE `FoldedBlock`, which still closes a big payload behind a
 * labelled toggle (BB-198: a transcript that inlines every hundred-line result
 * is "a bunch of JSON", not a conversation). The tree does not replace that
 * judgement — it is what you get when you open one.
 */
export const renderSessionJson: JsonRenderer = (value) => (
  <JsonTreeView
    value={value}
    defaultExpandDepth={2}
    className="rounded-md border border-border bg-muted/30 p-2 text-[11px]"
  />
);
