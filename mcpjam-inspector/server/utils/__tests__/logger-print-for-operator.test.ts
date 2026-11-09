import { afterEach, describe, expect, it, vi } from "vitest";
import { printForOperator } from "../logger.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("printForOperator", () => {
  it("prints on stderr in production without VERBOSE_LOGS, where the logger prints nothing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERBOSE_LOGS", "");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    printForOperator("[sandbox] fix this");
    expect(stderr).toHaveBeenCalledWith("[sandbox] fix this\n");
  });

  it.each([
    ["with VERBOSE_LOGS=true", "production", "true"],
    ["outside production", "development", ""],
  ])(
    "stays quiet %s, where the logger already prints it",
    (_case, nodeEnv, verbose) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("VERBOSE_LOGS", verbose);
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      printForOperator("[sandbox] fix this");
      expect(stderr).not.toHaveBeenCalled();
    },
  );
});
