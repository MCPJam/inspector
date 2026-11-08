import {
  isLegacySelection,
  isModelSelection,
  type RequestedModelSelection,
  type ModelSelection,
} from "@mcpjam/sdk/browser";
import { z } from "zod";
import { MAX_COMPARE_PANES } from "./compare-panes";

const id = z.string().min(1);
const ids = z.array(id);
const selection = z.custom<RequestedModelSelection>(
  (value) => isModelSelection(value) || isLegacySelection(value),
);

const pane = z.object({
  paneId: id,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("host"), hostId: id }),
    z.object({ kind: z.literal("environment"), environmentId: id }),
  ]),
  pickedSelection: z.custom<ModelSelection>(isModelSelection).optional(),
  serverIds: ids.nullish(),
  pluginVersionIds: ids.nullish(),
});
export type RecoveryPane = z.infer<typeof pane>;

const layout = z.object({
  projectId: id,
  multiModelEnabled: z.boolean(),
  hostIds: ids,
  modelSelections: z.array(selection).nullable(),
  selectedServers: ids,
});
export type ComparisonRecoveryLayout = z.infer<typeof layout> & {
  panes?: RecoveryPane[];
  unavailablePaneIds?: string[];
};

const column = z.object({
  compareId: id,
  kind: z.enum(["model", "host"]),
  order: z.number().int().nonnegative(),
  chatSessionId: id,
  hasMessages: z.boolean(),
});
export type ComparisonRecoveryColumn = z.infer<typeof column>;

const common = layout.extend({
  id,
  createdAt: z.number(),
  columns: z.array(column).min(1),
  continuationId: id,
  clickedColumn: id,
});
const record = z.discriminatedUnion("version", [
  common.extend({ version: z.literal(1), createdAt: z.number().optional() }),
  common.extend({
    version: z.literal(2),
    panes: z.array(pane).max(MAX_COMPARE_PANES),
    unavailablePaneIds: ids.optional(),
  }),
]);
export type ComparisonAuthRecovery = z.infer<typeof record>;

/** A redirect can land between releases. Parse the version that was saved,
 * and never match a child using its model, its client, or its position. */
export function readRecoveryRecord(
  raw: string,
  expected: { id: string; projectId: string },
) {
  const parsed = record.safeParse(JSON.parse(raw));
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.id !== expected.id || value.projectId !== expected.projectId)
    return null;
  const children = new Set(value.columns.map((c) => c.compareId));
  if (
    children.size !== value.columns.length ||
    !children.has(value.clickedColumn)
  )
    return null;
  if (value.version === 2) {
    // An unavailable pane has settings to restore but no mounted chat.
    // A loading pane is not exempt: wait for its real session before leaving.
    const unavailable = new Set(value.unavailablePaneIds);
    const hostColumns = value.columns.filter((c) => c.kind === "host");
    if (
      unavailable.size + hostColumns.length !== value.panes.length ||
      new Set(value.panes.map((p) => p.paneId)).size !== value.panes.length ||
      value.panes.some((p, index) =>
        unavailable.has(p.paneId)
          ? children.has(p.paneId)
          : !hostColumns.some(
              (c) => c.compareId === p.paneId && c.order === index,
            ),
      )
    )
      return null;
    if (
      new Set(value.columns.map((c) => c.chatSessionId)).size !==
      value.columns.length
    )
      return null;
  }
  return value;
}
