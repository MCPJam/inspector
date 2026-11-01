import { traceChatAuthRecovery } from "./chat-auth-recovery";
import type { RequestedModelSelection } from "@mcpjam/sdk/browser";
import type { PendingWriteResult } from "./scope-step-up-pending";

const PREFIX = "mcp-comparison-auth-v1:";
const PARAM = "comparisonRecovery";
export function hasComparisonAuthRecoveryRequest(): boolean {
  return new URLSearchParams(window.location.search).has(PARAM);
}
export interface ComparisonRecoveryLayout {
  projectId: string;
  multiModelEnabled: boolean;
  hostIds: string[];
  modelSelections: RequestedModelSelection[] | null;
  selectedServers: string[];
}
export interface ComparisonRecoveryColumn {
  compareId: string;
  kind: "model" | "host";
  order: number;
  chatSessionId: string;
  hasMessages: boolean;
}
export interface ComparisonAuthRecovery extends ComparisonRecoveryLayout {
  version: 1;
  id: string;
  createdAt: number;
  columns: ComparisonRecoveryColumn[];
  continuationId: string;
  clickedColumn: string;
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
    version: 1,
    id,
    columns: lanes,
    clickedColumn,
    continuationId,
    createdAt: Date.now(),
  };
  try {
    const raw = JSON.stringify(record);
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
    const record = JSON.parse(
      sessionStorage.getItem(PREFIX + id) ?? "null",
    ) as ComparisonAuthRecovery | null;
    if (
      !record ||
      record.version !== 1 ||
      record.id !== id ||
      record.projectId !==
        (projectId === "local"
          ? (window.location.pathname.match(/^\/p\/([^/]+)/)?.[1] ?? projectId)
          : projectId) ||
      !Array.isArray(record.columns) ||
      !Array.isArray(record.hostIds) ||
      !Array.isArray(record.selectedServers)
    )
      return null;
    if (
      !record.columns.every(
        (lane) =>
          typeof lane.chatSessionId === "string" &&
          typeof lane.compareId === "string" &&
          (lane.kind === "model" || lane.kind === "host") &&
          Number.isInteger(lane.order) &&
          typeof lane.hasMessages === "boolean",
      )
    )
      return null;
    if (
      !record.columns.length ||
      new Set(record.columns.map((lane) => `${lane.kind}:${lane.compareId}`))
        .size !== record.columns.length ||
      typeof record.multiModelEnabled !== "boolean" ||
      !record.columns.some((lane) => lane.compareId === record.clickedColumn) ||
      !record.hostIds.every((value) => typeof value === "string") ||
      !record.selectedServers.every((value) => typeof value === "string") ||
      (record.modelSelections !== null &&
        !Array.isArray(record.modelSelections))
    )
      return null;
    return record;
  } catch {
    return null;
  }
}
const restoredColumns = new Map<string, Set<string>>();
/**
 * A restored column loaded its history. Once every saved column has, the
 * saved comparison is cleared, so a later reload starts from the current
 * layout instead of bringing the old one back.
 */
export function markComparisonColumnRestored(
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
