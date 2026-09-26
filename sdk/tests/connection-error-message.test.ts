import { connectionErrorMessage } from "../src/mcp-client-manager/connection-error-message";

const url = new URL("http://user:secret@localhost:8082/mcp?key=secret#token");
const fallback = "Original transport details";
const message = (...errors: unknown[]) => connectionErrorMessage(url, errors, fallback);

describe("connection failure messages", () => {
  it("explains a nested connection refusal without exposing URL credentials", () => {
    const cause = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    expect(message(new TypeError("fetch failed", { cause }))).toBe(
      "Couldn't reach the server at http://localhost:8082/mcp: connection refused (ECONNREFUSED). Check that it's running and that the host and port are correct.",
    );
  });
  it.each(["code", "status", "statusCode"])("recognizes a 404 in %s without guessing its cause", (field) => {
    expect(message({ [field]: 404 })).toBe(
      "Server returned HTTP 404 at http://localhost:8082/mcp. Check the MCP endpoint and server logs.",
    );
  });
  it("recognizes an era-negotiation wrapper", () => {
    expect(message({ code: "ERA_NEGOTIATION_FAILED", data: { cause: { status: 404 } } })).toContain("HTTP 404");
  });
  it.each([401, 403, 500])("does not let an SSE 404 hide HTTP %i", (status) => {
    expect(message({ status }, { code: 404 })).toBe(fallback);
  });
  it("does not guess a status from arbitrary server text", () => {
    expect(message(new Error("Not found 404"))).toBe(fallback);
  });
  it("keeps unknown, DNS and timeout failures unchanged", () => {
    for (const error of [undefined, null, new Error("fetch failed"), { code: "ENOTFOUND" }, { code: "ETIMEDOUT" }]) {
      expect(message(error)).toBe(fallback);
    }
  });
  it("handles cyclic causes", () => {
    const error = { cause: undefined as unknown };
    error.cause = error;
    expect(message(error)).toBe(fallback);
  });
});
