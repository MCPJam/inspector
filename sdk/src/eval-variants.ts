import { EvalTest, type EvalTestConfig } from "./EvalTest.js";

export type EvalVariantEntry = {
  id: string;
  phrasing: string;
  label?: string;
  externalCaseId?: string;
};
/** The factory explicitly uses phrasing in its driver; identity is never derived from text. */
export function evalTestVariants(
  entries: readonly EvalVariantEntry[],
  makeConfig: (
    entry: Readonly<EvalVariantEntry>
  ) => Omit<EvalTestConfig, "id" | "externalCaseId">
): EvalTest[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.id) ||
      ids.has(entry.id)
    )
      throw new TypeError(
        "Variant IDs must be unique, URL-safe declared IDs of 1..128 characters"
      );
    if (entry.externalCaseId !== undefined && entry.externalCaseId !== entry.id)
      throw new TypeError("Variant externalCaseId must equal its declared id");
    if (typeof entry.phrasing !== "string" || !entry.phrasing.trim())
      throw new TypeError("Variant phrasing is required");
    ids.add(entry.id);
  }
  return entries.map(
    (entry) =>
      new EvalTest({
        ...makeConfig(Object.freeze({ ...entry })),
        id: entry.id,
        externalCaseId: entry.externalCaseId,
      })
  );
}
