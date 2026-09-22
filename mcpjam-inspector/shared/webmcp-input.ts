/** Shared validation for the HTTP and negotiated socket input boundaries. */
import { z } from "zod";
import {
  WEBMCP_INPUT_BATCH_LIMIT,
  WEBMCP_INPUT_TEXT_MAX_CHARS,
  type WebMcpInputEvent,
} from "./webmcp-inspector-protocol";
import type { BrowserPaneInputEvent } from "./browser-pane-input";

/**
 * One input event, bounded at both the HTTP and socket boundaries.
 *
 * `finite()` rather than a bare `number()` on every coordinate: JSON carries no
 * NaN, but a client computing a scale factor from a zero-height pane produces
 * one, and `JSON.stringify` turns it into `null` — which a permissive schema
 * would coerce rather than refuse. Negative coordinates are refused for the
 * same reason they are clamped downstream: they are never a thing a person did
 * to the pane.
 */
const coordinate = z.number().finite().nonnegative();
const modifiersSchema = z
  .object({
    alt: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    meta: z.boolean().optional(),
    shift: z.boolean().optional(),
  })
  .optional();
const mouseButtonSchema = z.enum(["left", "middle", "right"]);
/** Bounded so one event cannot ask the browser to hold a key name of any size. */
const keyNameSchema = z.string().min(1).max(64);

export const inputEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mouse_move"),
    x: coordinate,
    y: coordinate,
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("mouse_down"),
    x: coordinate,
    y: coordinate,
    button: mouseButtonSchema,
    clickCount: z.number().int().min(1).max(3).optional(),
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("mouse_up"),
    x: coordinate,
    y: coordinate,
    button: mouseButtonSchema,
    clickCount: z.number().int().min(1).max(3).optional(),
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("wheel"),
    x: coordinate,
    y: coordinate,
    // Deltas are signed — scrolling up is a negative number, not an error.
    deltaX: z.number().finite(),
    deltaY: z.number().finite(),
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("key_down"),
    key: keyNameSchema,
    code: keyNameSchema.optional(),
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("key_up"),
    key: keyNameSchema,
    code: keyNameSchema.optional(),
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string().max(WEBMCP_INPUT_TEXT_MAX_CHARS),
  }),
]);

export const webMcpSocketInputSchema = z.object({
  type: z.literal("input"),
  tabId: z.string().min(1).max(200).optional(),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  events: z.array(inputEventSchema).min(1).max(WEBMCP_INPUT_BATCH_LIMIT),
});

/** Upper bound includes JSON escaping of a full batch of pasted text. */
export const WEBMCP_SOCKET_INPUT_MAX_CHARS = 2 * 1024 * 1024;

/** Adapt at the boundary so both browser panes use the existing relay queue. */
export function toBrowserPaneInput(
  event: WebMcpInputEvent,
): BrowserPaneInputEvent {
  if (event.kind === "text") return { type: "text", text: event.text };
  const { kind, modifiers, ...fields } = event;
  const mask =
    (modifiers?.alt ? 1 : 0) |
    (modifiers?.ctrl ? 2 : 0) |
    (modifiers?.meta ? 4 : 0) |
    (modifiers?.shift ? 8 : 0);
  return {
    type: kind,
    ...fields,
    ...(modifiers === undefined ? {} : { modifiers: mask }),
  } as BrowserPaneInputEvent;
}

export function fromBrowserPaneInput(
  event: BrowserPaneInputEvent,
): WebMcpInputEvent {
  if (event.type === "text") return { kind: "text", text: event.text };
  const { type, modifiers, ...fields } = event;
  if (modifiers === undefined)
    return { kind: type, ...fields } as WebMcpInputEvent;
  return {
    kind: type,
    ...fields,
    modifiers: {
      alt: Boolean(modifiers & 1),
      ctrl: Boolean(modifiers & 2),
      meta: Boolean(modifiers & 4),
      shift: Boolean(modifiers & 8),
    },
  } as WebMcpInputEvent;
}
