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
  addBreadcrumb: jest.Mock;
  captureException: jest.Mock;
  captureMessage: jest.Mock;
  clone: jest.Mock;
  setClient: jest.Mock;
  setExtra: jest.Mock;
  setFingerprint: jest.Mock;
  setTag: jest.Mock;
  setUser: jest.Mock;
};

type MockSentryClient = {
  init: jest.Mock;
};

type MockSentryModule = {
  init: jest.Mock;
  NodeClient: jest.Mock;
  Scope: jest.Mock;
  defaultStackParser: jest.Mock;
  makeNodeTransport: jest.Mock;
};

function createMockSentryModule(): {
  captureScopes: MockSentryScope[];
  client: MockSentryClient;
  module: MockSentryModule;
  scope: MockSentryScope;
} {
  const captureScopes: MockSentryScope[] = [];

  const createScope = (): MockSentryScope => {
    const scope: MockSentryScope = {
      addBreadcrumb: jest.fn(),
      captureException: jest.fn(),
      captureMessage: jest.fn(),
      clone: jest.fn(),
      setClient: jest.fn(),
      setExtra: jest.fn(),
      setFingerprint: jest.fn(),
      setTag: jest.fn(),
      setUser: jest.fn(),
    };

    scope.clone.mockImplementation(() => {
      const clonedScope = createScope();
      captureScopes.push(clonedScope);
      return clonedScope;
    });

    return scope;
  };

  const scope = createScope();
  const client: MockSentryClient = {
    init: jest.fn(),
  };

  const module: MockSentryModule = {
    Scope: jest.fn().mockImplementation(() => scope),
    NodeClient: jest.fn().mockImplementation(() => client),
    defaultStackParser: jest.fn(),
    init: jest.fn(),
    makeNodeTransport: jest.fn(),
  };

  return {
    captureScopes,
    client,
    module,
    scope,
  };
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
    const { client, module } = createMockSentryModule();
    const loader = jest.fn().mockResolvedValue(module);
    __setSentryModuleLoaderForTests(loader);
    process.env.DO_NOT_TRACK = "1";

    await captureException(new Error("ignored"));

    expect(loader).not.toHaveBeenCalled();
    expect(module.NodeClient).not.toHaveBeenCalled();
    expect(module.init).not.toHaveBeenCalled();
    expect(client.init).not.toHaveBeenCalled();
  });

  it("does not initialize global sentry state", async () => {
    const { client, module } = createMockSentryModule();
    __setSentryModuleLoaderForTests(jest.fn().mockResolvedValue(module));

    await captureException(new Error("ignored"));

    expect(module.init).not.toHaveBeenCalled();
    expect(module.NodeClient).toHaveBeenCalledTimes(1);
    expect(client.init).toHaveBeenCalledTimes(1);
  });

  it("does not initialize when MCPJAM_TELEMETRY_DISABLED is set", async () => {
    const { client, module } = createMockSentryModule();
    const loader = jest.fn().mockResolvedValue(module);
    __setSentryModuleLoaderForTests(loader);
    process.env.MCPJAM_TELEMETRY_DISABLED = "1";

    await captureException(new Error("ignored"));

    expect(loader).not.toHaveBeenCalled();
    expect(module.NodeClient).not.toHaveBeenCalled();
    expect(module.init).not.toHaveBeenCalled();
    expect(client.init).not.toHaveBeenCalled();
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
    const { client, module, scope } = createMockSentryModule();
    const loader = jest.fn().mockResolvedValue(module);
    __setSentryModuleLoaderForTests(loader);

    await captureException(new Error("first"));
    await captureException(new Error("second"));
    await addBreadcrumb({ category: "eval-reporting", message: "breadcrumb" });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(module.NodeClient).toHaveBeenCalledTimes(1);
    expect(module.Scope).toHaveBeenCalledTimes(1);
    expect(module.init).not.toHaveBeenCalled();
    expect(client.init).toHaveBeenCalledTimes(1);
    expect(scope.clone).toHaveBeenCalledTimes(2);
    expect(scope.addBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it("captures eval reporting failures with hashed key tags and extras", async () => {
    const { captureScopes, module } = createMockSentryModule();
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

    expect(captureScopes).toHaveLength(1);
    const captureScope = captureScopes[0];
    expect(captureScope.captureException).toHaveBeenCalledWith(error);
    const expectedHash = createHash("sha256")
      .update("mcpjam_test_key")
      .digest("hex")
      .slice(0, 16);
    expect(captureScope.setUser).toHaveBeenCalledWith({ id: expectedHash });
    expect(captureScope.setTag).toHaveBeenCalledWith(
      "api_key_hash",
      expectedHash
    );
    expect(captureScope.setTag).toHaveBeenCalledWith(
      "entrypoint",
      "reportEvalResults"
    );
    expect(captureScope.setTag).toHaveBeenCalledWith(
      "endpoint",
      "/sdk/v1/evals/report"
    );
    expect(captureScope.setTag).toHaveBeenCalledWith("http_status", "404");
    expect(captureScope.setExtra).toHaveBeenCalledWith(
      "baseUrl",
      "https://example.com"
    );
    expect(captureScope.setExtra).toHaveBeenCalledWith("framework", "jest");
    expect(captureScope.setExtra).toHaveBeenCalledWith("has_api_key", true);
    expect(captureScope.setExtra).toHaveBeenCalledWith("result_count", 2);
  });

  it("suppresses duplicate captures for the same error instance", async () => {
    const { captureScopes, module } = createMockSentryModule();
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

    expect(captureScopes).toHaveLength(1);
    expect(captureScopes[0].captureException).toHaveBeenCalledTimes(1);
  });
});
