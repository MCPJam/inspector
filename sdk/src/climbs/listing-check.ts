/**
 * `verify_climb`'s first step: each kept change against the server's listing
 * now. A change is applied when the server lists the kept value, missing when
 * it still lists the old one, and different when it lists something else. The
 * check also masks the fields the kept changes touched, so a hash of the rest
 * of the listing says whether the server changed beyond them.
 */
import type { MockChange } from "../mocks/change-list.js";
import type { RealServerView } from "./types.js";

export type KeptChangeStatus = "applied" | "missing" | "different";

export type KeptChangeCheck = {
  path: string;
  summary: string;
  status: KeptChangeStatus;
  expected: unknown;
  actual: unknown;
};

export type ListingCheck = {
  /** True when every change is applied. */
  allApplied: boolean;
  applied: number;
  missing: number;
  different: number;
  changes: KeptChangeCheck[];
  /** Kept changes the listing cannot show, such as a rename: they are not judged. */
  notChecked: string[];
};

/** Key-sorted JSON, so two equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

const LISTED = ["title", "description", "inputSchema", "outputSchema", "annotations"] as const;
type Listed = (typeof LISTED)[number];
const isListed = (head: string): head is Listed => (LISTED as readonly string[]).includes(head);

export function checkKeptChanges(
  kept: readonly MockChange[],
  listing: Pick<RealServerView, "instructions" | "serverInfo" | "tools">,
  /** What the server listed before the climb, where known: it tells a change that is missing from one that differs. */
  old?: { instructions?: string; tools?: Record<string, Partial<Record<Listed, unknown>>> },
): ListingCheck {
  const changes: KeptChangeCheck[] = [];
  const notChecked: string[] = [];
  const judge = (path: string, summary: string, expected: unknown, actual: unknown, before: unknown) => {
    const status: KeptChangeStatus =
      canonical(actual) === canonical(expected) ? "applied" : before !== undefined && canonical(actual) === canonical(before) ? "missing" : "different";
    changes.push({ path, summary, status, expected, actual });
  };
  for (const change of kept) {
    for (const detail of change.details) {
      const head = detail.path.split(".")[0] ?? "";
      if (change.target === "server") {
        if (detail.path === "instructions") judge("instructions", detail.summary, detail.after, listing.instructions, old?.instructions);
        else notChecked.push(detail.path);
        continue;
      }
      const name = change.name ?? "";
      const tool = listing.tools.find((candidate) => candidate.name === name);
      const path = `tools.${name}.${detail.path}`;
      if (head === "hidden") {
        // A tool the kept change hid is applied when the server no longer lists it.
        changes.push({ path, summary: detail.summary, status: tool ? "missing" : "applied", expected: "not listed", actual: tool ? "listed" : "not listed" });
      } else if (isListed(head) && detail.path === head) {
        judge(path, detail.summary, detail.after, tool?.[head], old?.tools?.[name]?.[head]);
      } else if (head === "params" || head === "inputSchema") {
        // A hidden, fixed or described parameter is judged by the whole schema the server lists now.
        notChecked.push(path);
      } else {
        notChecked.push(path);
      }
    }
  }
  const count = (status: KeptChangeStatus) => changes.filter((entry) => entry.status === status).length;
  return {
    allApplied: changes.length > 0 && changes.every((entry) => entry.status === "applied"),
    applied: count("applied"),
    missing: count("missing"),
    different: count("different"),
    changes,
    notChecked,
  };
}

/** The tools with every field a kept change touched set to null, for the hash of everything else. */
export function maskKeptFields<T extends { name: string }>(tools: readonly T[], kept: readonly MockChange[]): Array<Record<string, unknown>> {
  const touched = new Map<string, Set<string>>();
  for (const change of kept) {
    if (change.target !== "tool" || change.name === undefined) continue;
    for (const detail of change.details) {
      const head = detail.path.split(".")[0] ?? "";
      touched.set(change.name, (touched.get(change.name) ?? new Set()).add(head === "params" ? "inputSchema" : head));
    }
  }
  return tools.map((tool) => {
    const masked: Record<string, unknown> = { ...tool };
    for (const field of touched.get(tool.name) ?? []) if (field !== "hidden" && field !== "answer") masked[field] = null;
    return masked;
  });
}
