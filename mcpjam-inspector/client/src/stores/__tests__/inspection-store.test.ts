import { describe, it, expect, beforeEach } from "vitest";
import { useInspectionStore, inspectionStoreKey } from "../inspection-store";
import type {
  ServerInspectionSnapshot,
  ServerInspectionDiff,
} from "@/lib/inspection/types";

function makeSnapshot(
  overrides: Partial<ServerInspectionSnapshot> = {},
): ServerInspectionSnapshot {
  return {
    init: { protocolVersion: "2025-03-26" },
    tools: [],
    capturedAt: Date.now(),
    ...overrides,
  };
}

function makeDiff(
  overrides: Partial<ServerInspectionDiff> = {},
): ServerInspectionDiff {
  return {
    initChanges: [],
    toolChanges: [{ type: "added", name: "new_tool" }],
    computedAt: Date.now(),
    ...overrides,
  };
}

describe("inspection-store", () => {
  beforeEach(() => {
    // Reset the store to clean state
    useInspectionStore.setState({ records: {} });
  });

  describe("inspectionStoreKey", () => {
    it("formats workspace::server key", () => {
      expect(inspectionStoreKey("ws1", "my-server")).toBe("ws1::my-server");
    });
  });

  describe("saveInspection + getRecord", () => {
    it("saves and retrieves a record", () => {
      const key = "ws::server1";
      const snapshot = makeSnapshot();
      const diff = makeDiff();

      useInspectionStore.getState().saveInspection(key, snapshot, diff);
      const record = useInspectionStore.getState().getRecord(key);

      expect(record).toBeDefined();
      expect(record!.latestSnapshot).toEqual(snapshot);
      expect(record!.latestDiff).toEqual(diff);
    });

    it("saves record with null diff (first connect)", () => {
      const key = "ws::server1";
      const snapshot = makeSnapshot();

      useInspectionStore.getState().saveInspection(key, snapshot, null);
      const record = useInspectionStore.getState().getRecord(key);

      expect(record!.latestDiff).toBeNull();
    });

    it("overwrites previous record for same key", () => {
      const key = "ws::server1";
      const snap1 = makeSnapshot({ capturedAt: 1000 });
      const snap2 = makeSnapshot({ capturedAt: 2000 });

      useInspectionStore.getState().saveInspection(key, snap1, null);
      useInspectionStore.getState().saveInspection(key, snap2, makeDiff());

      const record = useInspectionStore.getState().getRecord(key);
      expect(record!.latestSnapshot.capturedAt).toBe(2000);
      expect(record!.latestDiff).not.toBeNull();
    });

    it("returns undefined for unknown key", () => {
      expect(useInspectionStore.getState().getRecord("nope")).toBeUndefined();
    });
  });

  describe("clearForServer", () => {
    it("removes the record for a specific key", () => {
      const key = "ws::server1";
      useInspectionStore.getState().saveInspection(key, makeSnapshot(), null);
      expect(useInspectionStore.getState().getRecord(key)).toBeDefined();

      useInspectionStore.getState().clearForServer(key);
      expect(useInspectionStore.getState().getRecord(key)).toBeUndefined();
    });

    it("does not affect other keys", () => {
      const key1 = "ws::s1";
      const key2 = "ws::s2";
      useInspectionStore.getState().saveInspection(key1, makeSnapshot(), null);
      useInspectionStore.getState().saveInspection(key2, makeSnapshot(), null);

      useInspectionStore.getState().clearForServer(key1);
      expect(useInspectionStore.getState().getRecord(key1)).toBeUndefined();
      expect(useInspectionStore.getState().getRecord(key2)).toBeDefined();
    });
  });
});
