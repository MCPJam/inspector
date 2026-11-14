import { traceChatAuthRecovery } from "./chat-auth-recovery";
import {
  readRecoveryRecord,
  type ComparisonAuthRecovery,
  type ComparisonRecoveryLayout,
  type ComparisonRecoveryColumn,
} from "./comparison-recovery-record";
export type {
  ComparisonAuthRecovery,
  ComparisonRecoveryLayout,
  ComparisonRecoveryColumn,
} from "./comparison-recovery-record";
import type { PendingWriteResult } from "./scope-step-up-pending";

const PREFIX = "mcp-comparison-auth-v2:";
const LEGACY_PREFIX = "mcp-comparison-auth-v1:";
const PARAM = "comparisonRecovery";
export function hasComparisonAuthRecoveryRequest(): boolean {
  return new URLSearchParams(window.location.search).has(PARAM);
}
const layouts = new Map<string, ComparisonRecoveryLayout>();
const columns = new Map<string, Map<string, ComparisonRecoveryColumn>>();
export function registerComparisonLayout(
  id: string,
  layout: ComparisonRecoveryLayout,
) {
  layouts.set(id, layout);
  return () => {
    if (layouts.get(id) === layout) layouts.delete(id);
  };
}
export function registerComparisonColumn(
  id: string,
  column: ComparisonRecoveryColumn,
) {
  const group = columns.get(id) ?? new Map<string, ComparisonRecoveryColumn>();
  columns.set(id, group);
  const key = `${column.kind}:${column.compareId}`;
  group.set(key, column);
  return () => {
    if (group.get(key) === column) group.delete(key);
    if (!group.size) columns.delete(id);
  };
}
export function prepareComparisonAuthRecovery(
  id: string,
  clickedColumn: string,
  continuationId: string,
  expectedColumns?: number,
): PendingWriteResult {
  const layout = layouts.get(id);
  const lanes = [...(columns.get(id)?.values() ?? [])].sort(
    (a, b) => a.order - b.order,
  );
  if (expectedColumns !== undefined && lanes.length < expectedColumns)
    return { ok: false, reason: "loading" };
  if (
    (expectedColumns !== undefined && lanes.length !== expectedColumns) ||
    !layout ||
    !lanes.some((lane) => lane.compareId === clickedColumn)
  )
    return { ok: false, reason: "missing" };
  const record: ComparisonAuthRecovery = {
    ...layout,
    version: 2,
    panes: layout.panes ?? [],
    id,
    columns: lanes,
    clickedColumn,
    continuationId,
    createdAt: Date.now(),
  };
  try {
    const raw = JSON.stringify(record);
    // Layout and cards register in separate effects. Do not leave the page
    // with a mix of old children and a newly changed lineup.
    if (!readRecoveryRecord(raw, { id, projectId: layout.projectId }))
      return { ok: false, reason: "loading" };
    sessionStorage.setItem(PREFIX + id, raw);
    if (sessionStorage.getItem(PREFIX + id) !== raw)
      return { ok: false, reason: "storage" };
    const url = new URL(window.location.href);
    url.searchParams.delete("conversation");
    url.searchParams.set(PARAM, id);
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
    traceChatAuthRecovery("comparison_saved", {
      projectId: layout.projectId,
      continuationId,
      chatSessionId: lanes.find((lane) => lane.compareId === clickedColumn)
        ?.chatSessionId,
      storageOutcome: "verified",
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: "storage" };
  }
}
export function readComparisonAuthRecovery(
  projectId: string,
): ComparisonAuthRecovery | null {
  const id = new URLSearchParams(window.location.search).get(PARAM);
  if (!id) return null;
  try {
    const raw =
      sessionStorage.getItem(PREFIX + id) ??
      sessionStorage.getItem(LEGACY_PREFIX + id);
    if (raw === null) return null;
    const scope =
      projectId === "local"
        ? (window.location.pathname.match(/^\/p\/([^/]+)/)?.[1] ?? projectId)
        : projectId;
    return readRecoveryRecord(raw, { id, projectId: scope });
  } catch {
    return null;
  }
}
const restoredColumns = new Map<string, Set<string>>();
/**
 * A restored column loaded its history, or failed to. Once every saved column
 * has settled, the saved comparison is cleared, so a later reload starts from
 * the current layout instead of bringing the old one back.
 */
export function markComparisonColumnSettled(
  projectId: string,
  column: Pick<ComparisonRecoveryColumn, "kind" | "compareId">,
) {
  const record = readComparisonAuthRecovery(projectId);
  if (!record) return;
  const done = restoredColumns.get(record.id) ?? new Set<string>();
  restoredColumns.set(record.id, done);
  done.add(`${column.kind}:${column.compareId}`);
  if (
    record.columns.every((lane) => done.has(`${lane.kind}:${lane.compareId}`))
  ) {
    restoredColumns.delete(record.id);
    clearComparisonAuthRecovery();
  }
}
export function clearComparisonAuthRecovery() {
  const url = new URL(window.location.href);
  const id = url.searchParams.get(PARAM);
  if (id) {
    try {
      sessionStorage.removeItem(PREFIX + id);
      sessionStorage.removeItem(LEGACY_PREFIX + id);
    } catch {
      /* URL removal prevents reuse. */
    }
  }
  url.searchParams.delete(PARAM);
  window.history.replaceState(
    window.history.state,
    "",
    url.pathname + url.search + url.hash,
  );
}
