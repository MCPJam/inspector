import { createHash } from "node:crypto";
import { EvalReportingError } from "../src/errors";
import {
  __resetSentryForTests,
  __setSentryDsnForTests,
  __setSentryModuleLoaderForTests,
  addBreadcrumb,
  captureEvalReportingFailure,
  captureException,
} from "../src/sentry";

type MockSentryScope = {
  setExtra: jest.Mock;
  setFingerprint: jest.Mock;
  setTag: jest.Mock;
  setUser: jest.Mock;
};

type MockSentryModule = {
  addBreadcrumb: jest.Mock;
  captureException: jest.Mock;
  captureMessage: jest.Mock;
  init: jest.Mock;
  setTag: jest.Mock;
  withScope: jest.Mock;
};

function createMockSentryModule(): {
  module: MockSentryModule;
  scope: MockSentryScope;
} {
  const scope: MockSentryScope = {
    setExtra: jest.fn(),
    setFingerprint: jest.fn(),
    setTag: jest.fn(),
    setUser: jest.fn(),
  };
  const module: MockSentryModule = {
    addBreadcrumb: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    init: jest.fn(),
    setTag: jest.fn(),
    withScope: jest.fn((callback: (scope: MockSentryScope) => void) =>
      callback(scope)
    ),
  };

  return { module, scope };
}

describe("sdk sentry wrapper", () => {
  const originalDoNotTrack = process.env.DO_NOT_TRACK;
  const originalTelemetryDisabled = process.env.MCPJAM_TELEMETRY_DISABLED;

  beforeEach(() => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.MCPJAM_TELEMETRY_DISABLED;
    __resetSentryForTests();
    __setSentryDsnForTests("https://public@example.ingest.sentry.io/123");
  });

  afterEach(() => {
    __resetSentryForTests();
    if (originalDoNotTrack === undefined) {
      delete process.env.DO_NOT_TRACK;
    } else {
      process.env.DO_NOT_TRACK = originalDoNotTrack;
    }
    if (originalTelemetryDisabled === undefined) {
      delete process.env.MCPJAM_TELEMETRY_DISABLED;
    } else {
      process.env.MCPJAM_TELEMETRY_DISABLED = originalTelemetryDisabled;
    }
    jest.restoreAllMocks();
  });

  it("does not initialize when DO_NOT_TRACK is set", async () => {
    const { module } = createMockSentryModule();
    const loader = jest.fn().mockResolvedValue(module);
    __setSentryModuleLoaderForTests(loader);
    process.env.DO_NOT_TRACK = "1";

    await captureException(new Error("ignored"));

    expect(loader).not.toHaveBeenCalled();
    expect(module.init).not.toHaveBeenCalled();
  });

  it("does not initialize when MCPJAM_TELEMETRY_DISABLED is set", async () => {
    const { module } = createMockSentryModule();
    const loader = jest.fn().mockResolvedValue(module);
    __setSentryModuleLoaderForTests(loader);
    process.env.MCPJAM_TELEMETRY_DISABLED = "1";

    await captureException(new Error("ignored"));

    expect(loader).not.toHaveBeenCalled();
    expect(module.init).not.toHaveBeenCalled();
  });

  it("silently no-ops when @sentry/node is unavailable", async () => {
    const loader = jest.fn().mockRejectedValue(
      Object.assign(new Error("Cannot find module '@sentry/node'"), {
        code: "MODULE_NOT_FOUND",
      })
    );
    __setSentryModuleLoaderForTests(loader);

    await expect(captureException(new Error("ignored"))).resolves.toBeUndefined();
    await expect(
      addBreadcrumb({ category: "eval-reporting", message: "ignored" })
    ).resolves.toBeUndefined();

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("lazy initializes only once", async () => {
    const { module } = createMockSentryModule();
    const loader = jest.fn().mockResolvedValue(module);
    __setSentryModuleLoaderForTests(loader);

    await captureException(new Error("first"));
    await captureException(new Error("second"));
    await addBreadcrumb({ category: "eval-reporting", message: "breadcrumb" });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(module.init).toHaveBeenCalledTimes(1);
    expect(module.captureException).toHaveBeenCalledTimes(2);
    expect(module.addBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it("captures eval reporting failures with hashed key tags and extras", async () => {
    const { module, scope } = createMockSentryModule();
    __setSentryModuleLoaderForTests(jest.fn().mockResolvedValue(module));
    const error = new EvalReportingError("Not Found", {
      attemptCount: 1,
      endpoint: "/sdk/v1/evals/report",
      statusCode: 404,
    });

    await captureEvalReportingFailure(error, {
      apiKey: "mcpjam_test_key",
      baseUrl: "https://example.com",
      entrypoint: "reportEvalResults",
      framework: "jest",
      resultCount: 2,
      suiteName: "sdk-suite",
    });

    expect(module.captureException).toHaveBeenCalledWith(error);
    const expectedHash = createHash("sha256")
      .update("mcpjam_test_key")
      .digest("hex")
      .slice(0, 16);
    expect(scope.setUser).toHaveBeenCalledWith({ id: expectedHash });
    expect(scope.setTag).toHaveBeenCalledWith("api_key_hash", expectedHash);
    expect(scope.setTag).toHaveBeenCalledWith("entrypoint", "reportEvalResults");
    expect(scope.setTag).toHaveBeenCalledWith(
      "endpoint",
      "/sdk/v1/evals/report"
    );
    expect(scope.setTag).toHaveBeenCalledWith("http_status", "404");
    expect(scope.setExtra).toHaveBeenCalledWith("baseUrl", "https://example.com");
    expect(scope.setExtra).toHaveBeenCalledWith("framework", "jest");
    expect(scope.setExtra).toHaveBeenCalledWith("has_api_key", true);
    expect(scope.setExtra).toHaveBeenCalledWith("result_count", 2);
  });

  it("suppresses duplicate captures for the same error instance", async () => {
    const { module } = createMockSentryModule();
    __setSentryModuleLoaderForTests(jest.fn().mockResolvedValue(module));
    const error = new EvalReportingError("Duplicate", {
      endpoint: "/sdk/v1/evals/report",
      statusCode: 500,
    });

    await captureEvalReportingFailure(error, {
      apiKey: "mcpjam_test_key",
      entrypoint: "reportEvalResults",
      suiteName: "dup-suite",
    });
    await captureEvalReportingFailure(error, {
      apiKey: "mcpjam_test_key",
      entrypoint: "reportEvalResultsSafely",
      suiteName: "dup-suite",
    });

    expect(module.captureException).toHaveBeenCalledTimes(1);
  });
});
