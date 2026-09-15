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
 * No `height` / `maxHeight`, and no border or ground of its own: the card puts
 * every payload in one capped scroll box, exactly as the Playground does, and
 * a viewer that drew its own frame inside that would be a box in a box.
 *
 * ## What closes a big payload now
 *
 * The CARD, which starts collapsed — one header line per tool call, so a
 * transcript is a conversation rather than "a bunch of JSON" (BB-198). This
 * used to be a per-payload fold; the card doing it is both what the Playground
 * does and the more complete answer, since it hides the header clutter too.
 */
export const renderSessionJson: JsonRenderer = (value) => (
  <JsonTreeView
    value={value}
    defaultExpandDepth={2}
    className="p-2 text-[11px]"
  />
);
