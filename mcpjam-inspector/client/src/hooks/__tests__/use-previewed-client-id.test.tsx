/**
 * The previewed host is per-project state, and the hook's contract is that it
 * is reported ONLY under the project it was read for. Repairing a project
 * switch in an effect instead leaves one committed render in which the
 * PREVIOUS project's host id is reported under the NEW project id — long
 * enough for the Playground to preview, and act on, a foreign host.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePreviewedHostId } from "../use-previewed-client-id";
import {
  loadPreviewedHostId,
  savePreviewedHostId,
} from "@/lib/previewed-client-storage";

const STORAGE_KEY = "mcp-previewed-host-id";
const PROJECT = "p1";
const PROJECT_B = "p2";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("usePreviewedHostId — single project", () => {
  it("reads the persisted host on mount", () => {
    savePreviewedHostId(PROJECT, "host_a");

    const { result } = renderHook(() => usePreviewedHostId(PROJECT));
    expect(result.current[0]).toBe("host_a");
  });

  it("is null when nothing is persisted, and when there is no project", () => {
    expect(
      renderHook(() => usePreviewedHostId(PROJECT)).result.current[0],
    ).toBe(null);
    expect(renderHook(() => usePreviewedHostId(null)).result.current[0]).toBe(
      null,
    );
  });

  it("the setter persists and is reflected back", () => {
    const { result } = renderHook(() => usePreviewedHostId(PROJECT));

    act(() => result.current[1]("host_a"));
    expect(loadPreviewedHostId(PROJECT)).toBe("host_a");
    expect(result.current[0]).toBe("host_a");

    act(() => result.current[1](null));
    expect(loadPreviewedHostId(PROJECT)).toBeNull();
    expect(result.current[0]).toBeNull();
  });

  it("the setter is inert without a project", () => {
    const { result } = renderHook(() => usePreviewedHostId(null));
    act(() => result.current[1]("host_a"));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(result.current[0]).toBeNull();
  });

  it("a write from another surface reaches this one through the same-tab event", () => {
    const { result } = renderHook(() => usePreviewedHostId(PROJECT));

    act(() => savePreviewedHostId(PROJECT, "host_b"));
    expect(result.current[0]).toBe("host_b");
  });

  it("ignores same-tab writes that belong to another project", () => {
    savePreviewedHostId(PROJECT, "host_a");
    const { result } = renderHook(() => usePreviewedHostId(PROJECT));

    act(() => savePreviewedHostId(PROJECT_B, "host_b"));
    expect(result.current[0]).toBe("host_a");
  });
});

describe("usePreviewedHostId — project scoping", () => {
  it("never reports one project's host under another project's id", () => {
    savePreviewedHostId(PROJECT, "host_a");
    const seen: Array<{ projectId: string; hostId: string | null }> = [];

    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) => {
        const [hostId] = usePreviewedHostId(projectId);
        seen.push({ projectId, hostId });
        return hostId;
      },
      { initialProps: { projectId: PROJECT } },
    );
    expect(seen.some((r) => r.hostId === "host_a")).toBe(true);

    rerender({ projectId: PROJECT_B });

    // Not "the last render settles on null" — NO render under p2 may ever
    // carry p1's host, including the first one after the switch.
    expect(
      seen.filter((r) => r.projectId === PROJECT_B).map((r) => r.hostId),
    ).not.toContain("host_a");
  });

  it("adopts the new project's own persisted host after the switch", () => {
    savePreviewedHostId(PROJECT, "host_a");
    savePreviewedHostId(PROJECT_B, "host_b");
    const seen: Array<{ projectId: string; hostId: string | null }> = [];

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => {
        const value = usePreviewedHostId(projectId);
        seen.push({ projectId, hostId: value[0] });
        return value;
      },
      { initialProps: { projectId: PROJECT } },
    );

    rerender({ projectId: PROJECT_B });

    expect(result.current[0]).toBe("host_b");
    expect(
      seen.filter((r) => r.projectId === PROJECT_B).map((r) => r.hostId),
    ).not.toContain("host_a");
  });

  it("switching to no project at all drops the host in the same render", () => {
    savePreviewedHostId(PROJECT, "host_a");
    const seen: Array<string | null> = [];

    const { rerender } = renderHook(
      ({ projectId }: { projectId: string | null }) => {
        const [hostId] = usePreviewedHostId(projectId);
        seen.push(hostId);
        return hostId;
      },
      { initialProps: { projectId: PROJECT as string | null } },
    );

    const before = seen.length;
    rerender({ projectId: null });
    expect(seen.slice(before)).not.toContain("host_a");
  });
});

describe("usePreviewedHostId — foreign persisted values", () => {
  // The persisted shape (`{ [projectId]: hostId }`) is unchanged by the
  // scoping fix, so there is no migration — but a value written by an older
  // or unrecognized shape must read as "no host", never as some other
  // project's host.
  it.each([
    ["an unscoped bare id", JSON.stringify("host_a")],
    ["an array", JSON.stringify(["host_a"])],
    ["a null document", JSON.stringify(null)],
    ["unparseable garbage", "{not json"],
  ])("reads null for %s rather than resurrecting a foreign host", (_, raw) => {
    localStorage.setItem(STORAGE_KEY, raw);

    const { result } = renderHook(() => usePreviewedHostId(PROJECT));
    expect(result.current[0]).toBeNull();
  });

  it("a foreign-shaped document does not block a later legitimate write", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("host_a"));

    const { result } = renderHook(() => usePreviewedHostId(PROJECT));
    act(() => result.current[1]("host_b"));

    expect(result.current[0]).toBe("host_b");
    expect(loadPreviewedHostId(PROJECT)).toBe("host_b");
  });
});
