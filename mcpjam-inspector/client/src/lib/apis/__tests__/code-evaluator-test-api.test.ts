import { beforeEach, describe, expect, it, vi } from "vitest";

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: authFetchMock }));

import {
  CODE_EVALUATOR_TEST_FAILED_COPY,
  CodeEvaluatorTestError,
  testCodeEvaluator,
} from "../code-evaluator-test-api";

const REQUEST = {
  projectId: "project-1",
  suiteId: "suite-1",
  iterationId: "it-1",
  evaluator: { fileName: "check.py", script: "print(1)", threshold: 1 },
  network: "web" as const,
};

const RESULT = {
  runId: "run-1",
  iterationId: "it-1",
  input: "transcript",
  network: "web",
  result: {
    status: "scored",
    score: 1,
    threshold: 1,
    passed: true,
    reason: "Every total matches",
  },
  logs: { output: "checked 2\n", exitCode: 0, durationMs: 40 },
};

function respond(body: unknown, status = 200) {
  authFetchMock.mockResolvedValueOnce(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

async function failure(): Promise<CodeEvaluatorTestError> {
  const error = await testCodeEvaluator(REQUEST).catch((caught) => caught);
  expect(error).toBeInstanceOf(CodeEvaluatorTestError);
  return error;
}

beforeEach(() => authFetchMock.mockReset());

describe("testCodeEvaluator", () => {
  it("posts the draft to the suite's test route and returns the result", async () => {
    respond(RESULT);
    await expect(testCodeEvaluator(REQUEST)).resolves.toEqual(RESULT);
    const [path, init] = authFetchMock.mock.calls[0];
    expect(path).toBe(
      "/api/v1/projects/project-1/eval-suites/suite-1/code-evaluators/test",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      iterationId: "it-1",
      evaluator: { fileName: "check.py", script: "print(1)", threshold: 1 },
      network: "web",
    });
  });

  it("returns an evaluator error as a result, not a failure", async () => {
    const errored = {
      ...RESULT,
      input: "stored",
      result: { status: "error", error: "Stopped at its time limit." },
      logs: { output: "", durationMs: 60_000 },
    };
    respond(errored);
    await expect(testCodeEvaluator(REQUEST)).resolves.toEqual(errored);
  });

  it.each([
    [
      409,
      "This iteration's run hasn't finished. Test on an iteration from a finished run.",
    ],
    [
      429,
      "You just tested an evaluator on this iteration. Wait a few seconds, then try again.",
    ],
    [403, "Code evaluators is not currently available for your organization."],
    [404, "Eval iteration not found"],
    [503, "Every test box is busy. Try again in a minute."],
  ])("keeps the backend's message for a %i", async (status, message) => {
    respond({ code: "SOME_CODE", message }, status);
    const error = await failure();
    expect(error.message).toBe(message);
    expect(error.status).toBe(status);
    expect(error.code).toBe("SOME_CODE");
  });

  it("reads a message nested under error", async () => {
    respond(
      { error: { code: "RATE_LIMITED", message: "Wait a few seconds." } },
      429,
    );
    const error = await failure();
    expect(error.message).toBe("Wait a few seconds.");
    expect(error.code).toBe("RATE_LIMITED");
  });

  it("says what to do when a refusal carries no message", async () => {
    respond("<html>Bad gateway</html>", 502);
    expect((await failure()).message).toBe(CODE_EVALUATOR_TEST_FAILED_COPY);
  });

  it("says when the request never reached the server", async () => {
    authFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect((await failure()).message).toBe(
      "Couldn't reach the server to run the test. Check your connection, then run it again.",
    );
  });

  it("refuses an answer that isn't a test result", async () => {
    respond({ ...RESULT, input: "files" });
    expect((await failure()).message).toBe(
      "Couldn't read the test result. Run the test again.",
    );
  });
});
