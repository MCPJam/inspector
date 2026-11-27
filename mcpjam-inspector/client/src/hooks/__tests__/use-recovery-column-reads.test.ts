import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ComparisonAuthRecovery } from "@/lib/comparison-auth-recovery";
import { useRecoveryColumnReads } from "../use-recovery-column-reads";

const record = (id: string) => ({ id }) as ComparisonAuthRecovery;

describe("useRecoveryColumnReads", () => {
  it("hands the record to each column once", () => {
    const first = record("r1");
    const { result } = renderHook(() => useRecoveryColumnReads(first));
    expect(result.current.recoveryFor("model:a")).toBe(first);
    result.current.markRead("model:a");
    expect(result.current.recoveryFor("model:a")).toBeNull();
    expect(result.current.recoveryFor("model:b")).toBe(first);
  });

  it("hands a new record to every column again", () => {
    const { result, rerender } = renderHook(
      ({ current }) => useRecoveryColumnReads(current),
      { initialProps: { current: record("r1") } },
    );
    result.current.markRead("model:a");
    const next = record("r2");
    rerender({ current: next });
    expect(result.current.recoveryFor("model:a")).toBe(next);
  });
});
