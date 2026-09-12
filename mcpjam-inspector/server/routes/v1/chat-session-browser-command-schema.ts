import { z } from "zod";
// DERIVED, not restated: the published verb list is the contract's, and a
// hand-copied enum here is a surface that silently stops matching it.
import { BROWSER_AGENT_ACT_VERBS } from "@/shared/browser-agent-contract";
const id = z.string().min(1).max(128);
export const commandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("back"),
    observeAfter: z.enum(["a11y", "screenshot", "none"]).optional(),
  }),
  z.object({
    op: z.literal("forward"),
    observeAfter: z.enum(["a11y", "screenshot", "none"]).optional(),
  }),
  z.object({
    op: z.literal("reload"),
    observeAfter: z.enum(["a11y", "screenshot", "none"]).optional(),
  }),
  z.object({
    op: z.literal("invoke_page_tool"),
    toolKey: id,
    frameId: id.optional(),
    input: z.unknown(),
  }),
  z.object({ op: z.literal("cancel_page_tool"), invocationId: id }),
  z.object({
    op: z.literal("navigate"),
    url: z
      .string()
      .url()
      .max(8192)
      .refine(
        (url) => ["http:", "https:"].includes(new URL(url).protocol),
        "Browser navigation requires an HTTP or HTTPS URL",
      ),
    newTab: z.boolean().optional(),
    observeAfter: z.enum(["a11y", "screenshot", "none"]).optional(),
  }),
  z.object({
    op: z.literal("observe"),
    mode: z.enum([
      "a11y",
      "screenshot",
      "text",
      "dom",
      "console",
      "network",
      "dialog",
      "url",
      "page_tools",
    ]),
    requestId: id.optional(),
    rootRef: id.optional(),
    rootSelector: z.string().max(4096).optional(),
    filter: z.enum(["interactive", "all"]).optional(),
  }),
  z.object({
    op: z.literal("act"),
    verb: z.enum(BROWSER_AGENT_ACT_VERBS),
    target: z
      .union([
        z.object({ ref: id }),
        z.object({ selector: z.string().max(4096) }),
        z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
      ])
      .optional(),
    value: z.string().max(16000).optional(),
    expectedState: z.string().max(4096).optional(),
    observeAfter: z.enum(["a11y", "screenshot", "none"]).optional(),
  }),
]);
