const mockCaptureEvalReportingFailure = jest.fn().mockResolvedValue(undefined);

jest.mock("../src/sentry", () => ({
  captureEvalReportingFailure: mockCaptureEvalReportingFailure,
}));

import { uploadEvalArtifact } from "../src/upload-eval-artifact";
import { EvalReportingError } from "../src/errors";

function errorResponse(status: number, message: string): any {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: async () => ({ ok: false, error: message }),
  };
}

describe("uploadEvalArtifact", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    mockCaptureEvalReportingFailure.mockClear();
    jest.restoreAllMocks();
  });

  it("captures once when artifact parsing fails", async () => {
    await expect(
      uploadEvalArtifact({
        apiKey: "mcpjam_test_key",
        artifact: "{}",
        format: "custom",
        suiteName: "parse-failure",
      })
    ).rejects.toThrow("customParser is required when format is 'custom'");

    expect(mockCaptureEvalReportingFailure).toHaveBeenCalledTimes(1);
    expect(mockCaptureEvalReportingFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        apiKey: "mcpjam_test_key",
        artifactFormat: "custom",
        entrypoint: "uploadEvalArtifact",
        suiteName: "parse-failure",
      })
    );
  });

  it("captures once when reporting parsed artifact results fails", async () => {
    global.fetch = jest.fn().mockResolvedValue(errorResponse(404, "Not Found")) as any;

    await expect(
      uploadEvalArtifact({
        apiKey: "mcpjam_test_key",
        artifact: {},
        customParser: () => [{ caseTitle: "case-1", passed: true }],
        format: "custom",
        suiteName: "report-failure",
      })
    ).rejects.toBeInstanceOf(EvalReportingError);

    expect(mockCaptureEvalReportingFailure).toHaveBeenCalledTimes(1);
    expect(mockCaptureEvalReportingFailure).toHaveBeenCalledWith(
      expect.any(EvalReportingError),
      expect.objectContaining({
        apiKey: "mcpjam_test_key",
        artifactFormat: "custom",
        entrypoint: "uploadEvalArtifact",
        suiteName: "report-failure",
      })
    );
  });
});
