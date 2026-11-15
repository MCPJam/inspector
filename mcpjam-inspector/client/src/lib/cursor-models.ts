import type { ModelDefinition } from "@/shared/types";
import { isRuntimeAccountModel } from "@/shared/model-provider";

export type CursorModelCatalog = {
  configured: boolean;
  models: { modelId: string; displayName: string; retiredAt?: number }[];
};

/** Keep unavailable saved choices visible without replacing their identity. */
export function cursorModelRows(
  catalog: CursorModelCatalog | undefined,
  savedModelIds: readonly string[] = [],
): ModelDefinition[] {
  const entries = new Map(
    (catalog?.models ?? []).map((row) => [row.modelId, row]),
  );
  for (const id of ["cursor/auto", ...savedModelIds]) {
    if (isRuntimeAccountModel(id) && !entries.has(id))
      entries.set(id, {
        modelId: id,
        displayName: id === "cursor/auto" ? "Cursor Auto" : id,
      });
  }
  return [...entries.values()]
    .map((row): ModelDefinition => {
      const missing =
        row.modelId !== "cursor/auto" &&
        !catalog?.models.some((candidate) => candidate.modelId === row.modelId);
      const reason = !catalog
        ? "Loading Cursor models…"
        : !catalog.configured
          ? "Ask an organization admin to add a Cursor key in AI providers."
          : row.retiredAt !== undefined || missing
            ? `Cursor no longer offers ${row.displayName}. Choose another model for this client.`
            : undefined;
      return {
        id: row.modelId,
        name: row.modelId === "cursor/auto" ? "Cursor Auto" : row.displayName,
        provider: "cursor",
        hosted: false,
        ...(reason ? { disabled: true, disabledReason: reason } : {}),
      };
    })
    .sort((a, b) =>
      a.id === "cursor/auto"
        ? -1
        : b.id === "cursor/auto"
          ? 1
          : a.name.localeCompare(b.name),
    );
}
