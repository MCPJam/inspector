import { describe, expect, it } from "vitest";
import {
  classifyMcpHeader,
  decodeMcpHeaderValue,
  findMcpHeaderIssues,
} from "../src/mcp-client-manager/mcp-header-mirror.js";

const MODERN = "2026-07-28";

describe("classifyMcpHeader", () => {
  it("matches case-insensitively — the spec text itself changes casing between versions", () => {
    // `Mcp-Session-Id` in 2025-06-18, `MCP-Session-Id` in 2025-11-25.
    expect(classifyMcpHeader("Mcp-Session-Id")).toBe("session");
    expect(classifyMcpHeader("MCP-Session-Id")).toBe("session");
    // A literal `Mcp-` prefix test would drop this one.
    expect(classifyMcpHeader("MCP-Protocol-Version")).toBe("protocol-version");
    expect(classifyMcpHeader("mcp-protocol-version")).toBe("protocol-version");
  });

  it("classifies the mirrored families and leaves ordinary headers alone", () => {
    expect(classifyMcpHeader("Mcp-Method")).toBe("method");
    expect(classifyMcpHeader("Mcp-Name")).toBe("name");
    expect(classifyMcpHeader("Mcp-Param-Region")).toBe("param");
    expect(classifyMcpHeader("Last-Event-ID")).toBe("resumption");
    expect(classifyMcpHeader("content-type")).toBeUndefined();
    expect(classifyMcpHeader("authorization")).toBeUndefined();
  });
});

describe("decodeMcpHeaderValue", () => {
  it("passes a plain ASCII value through untouched", () => {
    expect(decodeMcpHeaderValue("us-west1")).toEqual({
      raw: "us-west1",
      encoded: false,
      value: "us-west1",
    });
  });

  it("decodes the sentinel back to UTF-8 (spec example)", () => {
    const decoded = decodeMcpHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?=");
    expect(decoded.encoded).toBe(true);
    expect(decoded.value).toBe("Hello, 世界");
  });

  it("decodes a value that merely LOOKS like the sentinel back to the literal", () => {
    // Clients must encode a plain value matching the sentinel pattern, so the
    // decoded form here is the literal `=?base64?literal?=`. The payload
    // itself contains `?`, which is why the suffix is matched at the END of
    // the value rather than at the first `?=` seen.
    const decoded = decodeMcpHeaderValue("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
    expect(decoded.encoded).toBe(true);
    expect(decoded.value).toBe("=?base64?literal?=");
  });

  it("treats the markers as case-sensitive", () => {
    const decoded = decodeMcpHeaderValue("=?BASE64?SGVsbG8=?=");
    expect(decoded.encoded).toBe(false);
    expect(decoded.value).toBe("=?BASE64?SGVsbG8=?=");
  });

  it("reports a sentinel whose payload will not decode instead of throwing", () => {
    const decoded = decodeMcpHeaderValue("=?base64?not valid base64!?=");
    expect(decoded.encoded).toBe(true);
    expect(decoded.decodeError).toBeTruthy();
    expect(decoded.value).toBe("=?base64?not valid base64!?=");
  });
});

describe("findMcpHeaderIssues", () => {
  const modernBody = {
    method: "tools/call",
    name: "execute_sql",
    protocolVersion: MODERN,
  };

  it("is silent when every mirrored header agrees with the body", () => {
    expect(
      findMcpHeaderIssues(
        {
          "MCP-Protocol-Version": MODERN,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "execute_sql",
        },
        modernBody,
      ),
    ).toEqual([]);
  });

  it("names the header that disagrees — the -32020 case", () => {
    const issues = findMcpHeaderIssues(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "bar",
      },
      modernBody,
    );
    expect(issues).toEqual([
      {
        kind: "mismatch",
        header: "Mcp-Name",
        headerValue: "bar",
        bodyValue: "execute_sql",
      },
    ]);
  });

  it("compares Mcp-Name AFTER decoding, so an encoded name is not a false mismatch", () => {
    const encodedName = {
      "MCP-Protocol-Version": MODERN,
      "Mcp-Method": "tools/call",
      // base64("Hello, 世界")
      "Mcp-Name": "=?base64?SGVsbG8sIOS4lueVjA==?=",
    };
    expect(
      findMcpHeaderIssues(encodedName, {
        ...modernBody,
        name: "Hello, 世界",
      }),
    ).toEqual([]);
  });

  it("flags a REQUIRED header that was never sent", () => {
    const issues = findMcpHeaderIssues(
      { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call" },
      modernBody,
    );
    expect(issues).toEqual([
      { kind: "missing", header: "mcp-name", bodyValue: "execute_sql" },
    ]);
  });

  it("does not require Mcp-Name for a method that does not carry one", () => {
    expect(
      findMcpHeaderIssues(
        { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/list" },
        { method: "tools/list", protocolVersion: MODERN },
      ),
    ).toEqual([]);
  });

  it("flags a sentinel value that will not decode", () => {
    const issues = findMcpHeaderIssues(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "=?base64?not valid!?=",
      },
      modernBody,
    );
    expect(issues).toEqual([
      {
        kind: "undecodable",
        header: "Mcp-Name",
        headerValue: "=?base64?not valid!?=",
      },
    ]);
  });

  it("flags a protocol-version header that disagrees with the body envelope", () => {
    const issues = findMcpHeaderIssues(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "execute_sql",
      },
      { ...modernBody, protocolVersion: "2025-11-25" },
    );
    expect(issues).toEqual([
      {
        kind: "mismatch",
        header: "MCP-Protocol-Version",
        headerValue: MODERN,
        bodyValue: "2025-11-25",
      },
    ]);
  });

  describe("version scope", () => {
    it("asserts nothing on a 2025-11-25 request, where the headers are not required", () => {
      expect(
        findMcpHeaderIssues(
          { "MCP-Protocol-Version": "2025-11-25" },
          { method: "tools/call", name: "execute_sql" },
        ),
      ).toEqual([]);
    });

    it("asserts nothing on a 2025-06-18 request", () => {
      expect(
        findMcpHeaderIssues(
          { "MCP-Protocol-Version": "2025-06-18" },
          { method: "tools/call", name: "execute_sql" },
        ),
      ).toEqual([]);
    });

    it("asserts nothing when no version is known at all", () => {
      expect(
        findMcpHeaderIssues({}, { method: "tools/call", name: "x" }),
      ).toEqual([]);
    });

    it("asserts nothing for an unrecognized version string", () => {
      expect(
        findMcpHeaderIssues(
          { "MCP-Protocol-Version": "not-a-version" },
          { method: "tools/call", name: "x", protocolVersion: "not-a-version" },
        ),
      ).toEqual([]);
    });

    it("uses the BODY version when the header is missing, so a dropped header is still caught", () => {
      const issues = findMcpHeaderIssues(
        { "Mcp-Method": "tools/list" },
        { method: "tools/list", protocolVersion: MODERN },
      );
      expect(issues).toEqual([
        {
          kind: "missing",
          header: "mcp-protocol-version",
          bodyValue: MODERN,
        },
      ]);
    });
  });
});
