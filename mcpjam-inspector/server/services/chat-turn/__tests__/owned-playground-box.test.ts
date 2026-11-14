import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(async () => {}),
  unavailable: vi.fn((): string | null => null),
}));
vi.mock("../../../utils/harness/playground-box.js", () => ({
  acquirePlaygroundHarnessBox: m.acquire,
  playgroundHarnessBoxUnavailableReason: m.unavailable,
}));
import {
  acquireOwnedPlaygroundHarnessBox,
  startPlaygroundBoxEarly,
} from "../owned-playground-box.js";
import { takeEarly } from "../../../utils/early-start.js";
import { TurnResources } from "../resources.js";

const args = { bearer: "tok", projectId: "p1", chatSessionId: "c1" };
const acquired = () => ({
  ok: true,
  box: {
    surface: "playground",
    binding: { sandboxRowId: "row", sandboxId: "sbx" },
    release: m.release,
  },
});

describe("acquireOwnedPlaygroundHarnessBox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands the box's release to the turn that holds it", async () => {
    m.acquire.mockResolvedValue(acquired());
    const resources = new TurnResources(() => {});
    const result = await acquireOwnedPlaygroundHarnessBox(resources, args);
    expect(result.ok).toBe(true);
    expect(m.acquire).toHaveBeenCalledWith(args);
    expect(m.release).not.toHaveBeenCalled();
    await resources.dispose();
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it("releases a box that arrives after its turn ended, and reports why", async () => {
    m.acquire.mockResolvedValue(acquired());
    const resources = new TurnResources(() => {});
    await resources.dispose();
    await expect(
      acquireOwnedPlaygroundHarnessBox(resources, args),
    ).rejects.toThrow("Cannot acquire resources after a turn ended");
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it("gives a refused box nothing to release", async () => {
    const refusal = {
      ok: false,
      refusal: { status: 503, error: "at capacity" },
    };
    m.acquire.mockResolvedValue(refusal);
    const own = vi.fn();
    await expect(acquireOwnedPlaygroundHarnessBox({ own }, args)).resolves.toBe(
      refusal,
    );
    expect(own).not.toHaveBeenCalled();
  });
});

describe("startPlaygroundBoxEarly", () => {
  const boxArgs = { ...args, harness: "claude-code" };
  beforeEach(() => {
    vi.clearAllMocks();
    m.unavailable.mockReturnValue(null);
  });

  it("books a member's conversation box at once, owned by the turn", async () => {
    m.acquire.mockResolvedValue(acquired());
    const resources = new TurnResources(() => {});
    const early = startPlaygroundBoxEarly(resources, "conversation", boxArgs, false);
    expect(early).toBeDefined();
    expect(m.acquire).toHaveBeenCalledWith(boxArgs);
    await expect(takeEarly(early!)).resolves.toMatchObject({ ok: true });
    await resources.dispose();
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it("leaves every box a check before the booking could refuse to its usual place", () => {
    const own = vi.fn();
    expect(startPlaygroundBoxEarly({ own }, "credential", boxArgs, false)).toBeUndefined();
    expect(startPlaygroundBoxEarly({ own }, "compare", boxArgs, true)).toBeUndefined();
    expect(startPlaygroundBoxEarly({ own }, null, boxArgs, false)).toBeUndefined();
    expect(
      startPlaygroundBoxEarly({ own }, "conversation", { ...boxArgs, chatSessionId: undefined }, false),
    ).toBeUndefined();
    expect(
      startPlaygroundBoxEarly({ own }, "conversation", { ...boxArgs, harness: undefined }, false),
    ).toBeUndefined();
    m.unavailable.mockReturnValue("this server can't run boxes");
    expect(startPlaygroundBoxEarly({ own }, "conversation", boxArgs, false)).toBeUndefined();
    expect(m.acquire).not.toHaveBeenCalled();
  });
});
