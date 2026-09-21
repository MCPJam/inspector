import { beforeEach, describe, expect, it, vi } from "vitest";
import { track } from "../analytics";
import { trackStaleProjectReturnRecovered } from "../project-route-telemetry";

vi.mock("../analytics", () => ({ track: vi.fn() }));

describe("project route recovery telemetry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits only low-cardinality recovery properties", () => {
    trackStaleProjectReturnRecovered("switched");

    expect(vi.mocked(track)).toHaveBeenCalledWith(
      "project_route_stale_return_recovered",
      { location: "signin-return", outcome: "switched" },
    );
  });
});
