import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RequestLogContext, SystemLogContext } from "../log-events.js";

// Mock Sentry before importing logger
vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// Mock Axiom
const mockIngest = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);
vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn().mockImplementation(() => ({
    ingest: mockIngest,
    flush: mockFlush,
  })),
}));

const baseRequestContext: RequestLogContext = {
  event: "http.request.completed",
  timestamp: "2024-01-01T00:00:00.000Z",
  environment: "test",
  release: null,
  component: "http",
  requestId: "req-abc",
  route: "/api/web/test",
  method: "GET",
  authType: "unknown",
};

const baseSystemContext: SystemLogContext = {
  event: "mcp.connection.closed_with_pending_requests",
  timestamp: "2024-01-01T00:00:00.000Z",
  environment: "test",
  release: null,
  component: "process",
  requestId: null,
  route: null,
  method: null,
  authType: "system",
};

describe("logger", () => {
  beforeEach(() => {
    vi.resetModules();
    mockIngest.mockClear();
    mockFlush.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("axiom ingestion", () => {
    it("initializes Axiom client when AXIOM_TOKEN and AXIOM_DATASET are set", async () => {
      vi.stubEnv("AXIOM_TOKEN", "test-token");
      vi.stubEnv("AXIOM_DATASET", "test-dataset");
      vi.stubEnv("NODE_ENV", "production");

      const { Axiom } = await import("@axiomhq/js");
      await import("../logger.js");

      expect(Axiom).toHaveBeenCalledWith({ token: "test-token" });
    });

    it("does not initialize Axiom client when AXIOM_TOKEN is missing", async () => {
      vi.stubEnv("AXIOM_TOKEN", "");
      vi.stubEnv("AXIOM_DATASET", "test-dataset");

      const { Axiom } = await import("@axiomhq/js");
      (Axiom as ReturnType<typeof vi.fn>).mockClear();

      await import("../logger.js");

      expect(Axiom).not.toHaveBeenCalled();
    });

    it("does not initialize Axiom client when AXIOM_DATASET is missing", async () => {
      vi.stubEnv("AXIOM_TOKEN", "test-token");
      delete process.env.AXIOM_DATASET;

      const { Axiom } = await import("@axiomhq/js");
      (Axiom as ReturnType<typeof vi.fn>).mockClear();

      await import("../logger.js");

      expect(Axiom).not.toHaveBeenCalled();
    });

    describe("when Axiom is configured", () => {
      let logger: (typeof import("../logger.js"))["logger"];

      beforeEach(async () => {
        vi.stubEnv("AXIOM_TOKEN", "test-token");
        vi.stubEnv("AXIOM_DATASET", "test-dataset");
        vi.stubEnv("NODE_ENV", "production");

        const mod = await import("../logger.js");
        logger = mod.logger;
      });

      it("ingests error logs to Axiom with error details", () => {
        const error = new Error("something broke");
        logger.error("fail", error, { requestId: "abc" });

        expect(mockIngest).toHaveBeenCalledWith("test-dataset", [
          {
            level: "error",
            message: "fail",
            environment: "unknown",
            requestId: "abc",
            error: "something broke",
          },
        ]);
      });

      it("ingests error logs with stringified non-Error objects", () => {
        logger.error("fail", "string-error");

        expect(mockIngest).toHaveBeenCalledWith("test-dataset", [
          expect.objectContaining({
            level: "error",
            message: "fail",
            error: "string-error",
          }),
        ]);
      });

      it("ingests warn logs to Axiom", () => {
        logger.warn("watch out", { userId: "123" });

        expect(mockIngest).toHaveBeenCalledWith("test-dataset", [
          {
            level: "warn",
            message: "watch out",
            environment: "unknown",
            userId: "123",
          },
        ]);
      });

      it("ingests info logs to Axiom", () => {
        logger.info("started", { port: 3000 });

        expect(mockIngest).toHaveBeenCalledWith("test-dataset", [
          {
            level: "info",
            message: "started",
            environment: "unknown",
            port: 3000,
          },
        ]);
      });

      it("ingests debug logs to Axiom", () => {
        logger.debug("trace", "arg1", "arg2");

        expect(mockIngest).toHaveBeenCalledWith("test-dataset", [
          {
            level: "debug",
            message: "trace",
            environment: "unknown",
            args: ["arg1", "arg2"],
          },
        ]);
      });

      it("flushes Axiom on logger.flush()", async () => {
        await logger.flush();
        expect(mockFlush).toHaveBeenCalled();
      });
    });
  });

  describe("logger.event", () => {
    let logger: (typeof import("../logger.js"))["logger"];
    let captureException: ReturnType<typeof vi.fn>;
    let captureMessage: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.stubEnv("AXIOM_TOKEN", "test-token");
      vi.stubEnv("AXIOM_DATASET", "test-dataset");
      vi.stubEnv("NODE_ENV", "production");

      const mod = await import("../logger.js");
      logger = mod.logger;

      const sentry = await import("@sentry/node");
      captureException = vi.mocked(sentry.captureException);
      captureMessage = vi.mocked(sentry.captureMessage);
      captureException.mockClear();
      captureMessage.mockClear();
    });

    it("ingests a typed event to Axiom with all required fields", () => {
      logger.event("http.request.completed", baseRequestContext, { statusCode: 200 });

      expect(mockIngest).toHaveBeenCalledWith(
        "test-dataset",
        [
          expect.objectContaining({
            event: "http.request.completed",
            environment: "test",
            requestId: "req-abc",
            route: "/api/web/test",
            method: "GET",
            component: "http",
            authType: "unknown",
            statusCode: 200,
          }),
        ],
      );
    });

    it("calls Sentry.captureException for *.failed events with an Error", () => {
      const err = new Error("boom");
      logger.event(
        "http.request.failed",
        baseRequestContext,
        { statusCode: 500, errorCode: "unhandled_exception" },
        { error: err },
      );

      expect(captureException).toHaveBeenCalledWith(err, expect.any(Object));
      expect(captureMessage).not.toHaveBeenCalled();
    });

    it("calls Sentry.captureMessage for *.failed events without an Error", () => {
      logger.event(
        "http.request.failed",
        baseRequestContext,
        { statusCode: 500, errorCode: "internal_error" },
      );

      expect(captureMessage).toHaveBeenCalledWith(
        "http.request.failed",
        expect.objectContaining({ level: "error" }),
      );
    });

    it("does not call Sentry for non-failed events (http.request.completed)", () => {
      logger.event("http.request.completed", baseRequestContext, { statusCode: 200 });

      expect(captureException).not.toHaveBeenCalled();
      expect(captureMessage).not.toHaveBeenCalled();
    });

    it("does not call Sentry when sentry: false is passed", () => {
      const err = new Error("boom");
      logger.event(
        "http.request.failed",
        baseRequestContext,
        { statusCode: 500, errorCode: "internal_error" },
        { error: err, sentry: false },
      );

      expect(captureException).not.toHaveBeenCalled();
      expect(captureMessage).not.toHaveBeenCalled();
    });
  });

  describe("logger.systemEvent", () => {
    let logger: (typeof import("../logger.js"))["logger"];

    beforeEach(async () => {
      vi.stubEnv("AXIOM_TOKEN", "test-token");
      vi.stubEnv("AXIOM_DATASET", "test-dataset");
      vi.stubEnv("NODE_ENV", "production");

      const mod = await import("../logger.js");
      logger = mod.logger;
      mockIngest.mockClear();
    });

    it("ingests a system event to Axiom with system envelope (requestId/route/method all null)", () => {
      logger.systemEvent(
        "mcp.connection.closed_with_pending_requests",
        baseSystemContext,
        { errorCode: "connection_closed" },
      );

      expect(mockIngest).toHaveBeenCalledWith(
        "test-dataset",
        [
          expect.objectContaining({
            event: "mcp.connection.closed_with_pending_requests",
            requestId: null,
            route: null,
            method: null,
            authType: "system",
            errorCode: "connection_closed",
          }),
        ],
      );
    });
  });
});
