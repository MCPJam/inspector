/**
 * Lookups over a flow's fields, and the answers an empty draft already holds.
 *
 * Defaults are DERIVED from the flow rather than stored: a stored default
 * would freeze the portal's preselection as it stood the day the submission
 * was created, and read as an answer somebody gave. Every function that
 * judges answers merges them in itself, so a caller passes the stored
 * answers and cannot forget.
 *
 * Pure. Safe from the browser entry.
 */

import type {
  DirectoryAnswer,
  DirectoryAnswerValue,
  DirectoryFlow,
  DirectoryFlowField,
} from "./types.js";

export function directoryFlowField(
  flow: DirectoryFlow,
  key: string
): DirectoryFlowField | undefined {
  for (const step of flow.steps) {
    const field = step.fields.find((entry) => entry.key === key);
    if (field) return field;
  }
  return undefined;
}

/** The answers an empty draft holds before anyone types: fields with a `default`. */
export function directoryFlowDefaults(
  flow: DirectoryFlow
): Array<{ key: string; value: DirectoryAnswerValue }> {
  return flow.steps.flatMap((step) =>
    step.fields.flatMap((field) =>
      field.default === undefined
        ? []
        : [{ key: field.key, value: field.default }]
    )
  );
}

/** The stored answers plus a `default` answer for each defaulted field nobody answered. */
export function withDirectoryFlowDefaults(
  flow: DirectoryFlow,
  answers: readonly DirectoryAnswer[]
): DirectoryAnswer[] {
  const stored = new Set(answers.map((answer) => answer.key));
  return [
    ...answers,
    ...directoryFlowDefaults(flow)
      .filter((entry) => !stored.has(entry.key))
      .map((entry) => ({ ...entry, origin: "default" as const })),
  ];
}

/**
 * The wording revision an answer to `key` is stamped with: the field's own,
 * or the flow's version. A confirmation made under another revision has to be
 * made again, because the person confirmed different words.
 */
export function directoryFieldWordingRevision(
  flow: DirectoryFlow,
  key: string
): string | undefined {
  const field = directoryFlowField(flow, key);
  return field && (field.wordingRevision ?? flow.version);
}

/** No answer at all: empty text, an unticked box, an empty list, no complete row. */
export function isBlankAnswer(
  field: DirectoryFlowField,
  value: DirectoryAnswerValue | undefined
): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value === "string") return value.trim() === "";
  if (!Array.isArray(value)) return false;
  const columns = field.pairs?.keys;
  if (!columns) return value.length === 0;
  return !(value as ReadonlyArray<string | Record<string, string>>).some(
    (row) =>
      typeof row === "object" &&
      columns.every((column) => (row[column] ?? "").trim() !== "")
  );
}
