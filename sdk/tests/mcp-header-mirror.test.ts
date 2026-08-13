import { describe, expect, it } from "vitest";
import {
  buildMcpParamHeaders,
  classifyMcpHeader,
  decodeMcpHeaderValue,
  encodeMcpHeaderValue,
  evaluateMcpHeaders,
  findMcpHeaderIssues,
  scanXMcpHeaderDeclarations,
  stripXMcpHeaderAnnotations,
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

describe("evaluateMcpHeaders", () => {
  const modernBody = {
    method: "tools/call",
    name: "execute_sql",
    protocolVersion: MODERN,
  };

  function statuses(rows: ReturnType<typeof evaluateMcpHeaders>) {
    return rows.map((row) => [row.name, row.status]);
  }

  it("says which body field each conforming header matched", () => {
    const rows = evaluateMcpHeaders(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "execute_sql",
      },
      modernBody,
    );
    expect(rows).toEqual([
      {
        name: "MCP-Protocol-Version",
        family: "protocol-version",
        status: "match",
        raw: MODERN,
        decoded: undefined,
        bodyField: "._meta protocolVersion",
      },
      {
        name: "Mcp-Method",
        family: "method",
        status: "match",
        raw: "tools/call",
        decoded: undefined,
        bodyField: ".method",
      },
      {
        name: "Mcp-Name",
        family: "name",
        status: "match",
        raw: "execute_sql",
        decoded: undefined,
        bodyField: ".params.name",
      },
    ]);
  });

  it("reports the body value on the row that disagrees", () => {
    const rows = evaluateMcpHeaders(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "bar",
      },
      modernBody,
    );
    expect(rows[2]).toMatchObject({
      name: "Mcp-Name",
      status: "mismatch",
      raw: "bar",
      bodyValue: "execute_sql",
    });
  });

  it("distinguishes an absent REQUIRED header from an absent optional one", () => {
    // The whole point of the third slot: both are blank on the wire, and only
    // one of them is a -32020.
    expect(
      statuses(
        evaluateMcpHeaders(
          { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call" },
          modernBody,
        ),
      ),
    ).toEqual([
      ["MCP-Protocol-Version", "match"],
      ["Mcp-Method", "match"],
      ["mcp-name", "missing"],
    ]);

    expect(
      statuses(
        evaluateMcpHeaders(
          { "MCP-Protocol-Version": MODERN, "Mcp-Method": "server/discover" },
          { method: "server/discover", protocolVersion: MODERN },
        ),
      ),
    ).toEqual([
      ["MCP-Protocol-Version", "match"],
      ["Mcp-Method", "match"],
      ["mcp-name", "not-required"],
    ]);
  });

  it("names params.uri as the source for resources/read", () => {
    const rows = evaluateMcpHeaders(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "resources/read",
        "Mcp-Name": "file:///a.json",
      },
      {
        method: "resources/read",
        name: "file:///a.json",
        protocolVersion: MODERN,
      },
    );
    expect(rows[2]).toMatchObject({ status: "match", bodyField: ".params.uri" });
  });

  it("surfaces the decoded value alongside the raw sentinel", () => {
    const rows = evaluateMcpHeaders(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "=?base64?SGVsbG8sIOS4lueVjA==?=",
      },
      { ...modernBody, name: "Hello, 世界" },
    );
    expect(rows[2]).toMatchObject({
      status: "match",
      raw: "=?base64?SGVsbG8sIOS4lueVjA==?=",
      decoded: "Hello, 世界",
    });
  });

  it("leaves `decoded` unset when the sentinel does not decode", () => {
    // Otherwise the row would print the raw value twice, as if it were a
    // successful decode to itself.
    const rows = evaluateMcpHeaders(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "=?base64?not valid!?=",
      },
      modernBody,
    );
    expect(rows[2]).toMatchObject({ status: "undecodable", decoded: undefined });
  });

  it("shows Mcp-Param-* without claiming a verdict it cannot reach", () => {
    // The captured body values carry no arguments, so there is nothing to
    // compare against; a green check here would be a lie.
    const rows = evaluateMcpHeaders(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "execute_sql",
        "Mcp-Param-Region": "us-west1",
      },
      modernBody,
    );
    expect(rows[3]).toMatchObject({
      name: "Mcp-Param-Region",
      family: "param",
      status: "unchecked",
    });
    // ...and an unverifiable param must not leak into the -32020 defect list.
    expect(
      findMcpHeaderIssues(
        {
          "MCP-Protocol-Version": MODERN,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "execute_sql",
          "Mcp-Param-Region": "=?base64?not valid!?=",
        },
        modernBody,
      ),
    ).toEqual([]);
  });

  describe("version scope", () => {
    it("judges nothing on a legacy request — the headers are not mirrored there", () => {
      expect(
        statuses(
          evaluateMcpHeaders(
            {
              "MCP-Protocol-Version": "2025-11-25",
              "MCP-Session-Id": "01H8XQ",
              "Last-Event-ID": "42",
            },
            { method: "tools/call", name: "execute_sql" },
          ),
        ),
      ).toEqual([
        ["MCP-Protocol-Version", "unchecked"],
        ["MCP-Session-Id", "unchecked"],
        ["Last-Event-ID", "unchecked"],
      ]);
    });

    it("does not invent a missing-header row on a legacy request", () => {
      // `Mcp-Method`/`Mcp-Name` do not exist before 2026-07-28.
      expect(
        evaluateMcpHeaders(
          { "MCP-Protocol-Version": "2025-06-18" },
          { method: "tools/call", name: "execute_sql" },
        ),
      ).toEqual([
        {
          name: "MCP-Protocol-Version",
          family: "protocol-version",
          status: "unchecked",
          raw: "2025-06-18",
          decoded: undefined,
        },
      ]);
    });

    it("does not flag an undecodable sentinel on a legacy request", () => {
      // A legacy value that merely resembles the sentinel is just a value.
      const rows = evaluateMcpHeaders(
        {
          "MCP-Protocol-Version": "2025-11-25",
          "Mcp-Name": "=?base64?not valid!?=",
        },
        { method: "tools/call" },
      );
      expect(rows.map((row) => row.status)).toEqual(["unchecked", "unchecked"]);
    });

    it("uses the body version when the header was dropped", () => {
      expect(
        statuses(
          evaluateMcpHeaders(
            { "Mcp-Method": "tools/list" },
            { method: "tools/list", protocolVersion: MODERN },
          ),
        ),
      ).toEqual([
        ["mcp-protocol-version", "missing"],
        ["Mcp-Method", "match"],
        ["mcp-name", "not-required"],
      ]);
    });

    it("cross-checks nothing when no body was captured", () => {
      expect(
        statuses(
          evaluateMcpHeaders(
            { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/list" },
            undefined,
          ),
        ),
      ).toEqual([
        ["MCP-Protocol-Version", "unchecked"],
        ["Mcp-Method", "unchecked"],
      ]);
    });
  });
});

describe("SEP-2663 task routing headers", () => {
  // The extension makes `Mcp-Name: <taskId>` a MUST for these three methods
  // (SEP-2663, "Streamable HTTP: Routing Headers"). `transport-utils` already
  // SENDS it; a verdict that called it optional would hide the exact routing
  // defect a routed deployment fails on.
  for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
    it(`requires Mcp-Name for ${method} and names taskId as its source`, () => {
      const rows = evaluateMcpHeaders(
        { "MCP-Protocol-Version": MODERN, "Mcp-Method": method },
        // `name` is what `deriveMirroredBodyValues` reads out of
        // `params.taskId` for these methods — the header is what's absent.
        { method, name: "task-42", protocolVersion: MODERN },
      );
      expect(rows[2]).toMatchObject({
        name: "mcp-name",
        status: "missing",
        bodyField: ".params.taskId",
      });
    });
  }

  it("matches Mcp-Name against the task id when it was sent", () => {
    const rows = evaluateMcpHeaders(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tasks/get",
        "Mcp-Name": "task-42",
      },
      { method: "tasks/get", name: "task-42", protocolVersion: MODERN },
    );
    expect(rows[2]).toMatchObject({ status: "match", bodyField: ".params.taskId" });
  });

  it("leaves a non-routed tasks method optional", () => {
    // Only get/update/cancel are listed; `tasks/list` carries no routing key.
    const rows = evaluateMcpHeaders(
      { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tasks/list" },
      { method: "tasks/list", protocolVersion: MODERN },
    );
    expect(rows[2]).toMatchObject({ name: "mcp-name", status: "not-required" });
  });
});

describe("undecodable is claimed only where the sentinel is defined", () => {
  it("flags a malformed sentinel in Mcp-Param-*", () => {
    // Servers MUST reject a recognized `Mcp-Param-{Name}` carrying invalid
    // characters, so this one IS a defect even though the value cannot be
    // cross-checked against the body.
    const rows = evaluateMcpHeaders(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "execute_sql",
        "Mcp-Param-Region": "=?base64?not valid!?=",
      },
      { method: "tools/call", name: "execute_sql", protocolVersion: MODERN },
    );
    expect(rows[3]).toMatchObject({
      name: "Mcp-Param-Region",
      status: "undecodable",
    });
  });

  it("does NOT flag a sentinel-looking session or resumption value", () => {
    // Neither header has an encoded form in any version, so a value that
    // resembles the sentinel is just a value — not a -32020.
    const rows = evaluateMcpHeaders(
      {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/list",
        "MCP-Session-Id": "=?base64?not valid!?=",
        "Last-Event-ID": "=?base64?not valid!?=",
      },
      { method: "tools/list", protocolVersion: MODERN },
    );
    const byName = Object.fromEntries(rows.map((row) => [row.name, row.status]));
    expect(byName["MCP-Session-Id"]).toBe("unchecked");
    expect(byName["Last-Event-ID"]).toBe("unchecked");
  });
});

describe("encodeMcpHeaderValue", () => {
  it("round-trips through decodeMcpHeaderValue for every value class", () => {
    // The pair is only useful if it is an exact inverse: a value we encode and
    // a server decodes must be the value we started with, or the server's
    // header/body cross-check fails on a request we built correctly.
    for (const value of [
      "us-west1",
      "Ärger", // non-ASCII
      "  padded  ", // field parsing would strip these
      "", // empty is not a legal field value
      "=?base64?already?=", // must not be mistaken for a real sentinel
      "tab\tseparated",
    ]) {
      expect(decodeMcpHeaderValue(encodeMcpHeaderValue(value)).value).toBe(
        value
      );
    }
  });

  it("leaves a safe ASCII value unencoded so the wire stays readable", () => {
    expect(encodeMcpHeaderValue("us-west1")).toBe("us-west1");
    expect(encodeMcpHeaderValue("tab\tseparated")).toBe("tab\tseparated");
  });

  it("wraps a value that already looks like the sentinel", () => {
    // Otherwise a decoder cannot tell a literal from an encoding.
    const encoded = encodeMcpHeaderValue("=?base64?already?=");
    expect(encoded).not.toBe("=?base64?already?=");
    expect(decodeMcpHeaderValue(encoded).encoded).toBe(true);
  });
});

describe("scanXMcpHeaderDeclarations", () => {
  it("collects a declaration reachable through a chain of `properties`", () => {
    const scan = scanXMcpHeaderDeclarations({
      type: "object",
      properties: {
        region: { type: "string", "x-mcp-header": "Region" },
        nested: {
          type: "object",
          properties: { tier: { type: "integer", "x-mcp-header": "Tier" } },
        },
        query: { type: "string" },
      },
    });
    expect(scan).toEqual({
      valid: true,
      declarations: [
        { path: ["region"], headerName: "Region", type: "string" },
        { path: ["nested", "tier"], headerName: "Tier", type: "integer" },
      ],
    });
  });

  it("rejects a declaration that is not statically reachable", () => {
    // SEP-2243: an annotation anywhere off the `properties` chain invalidates
    // the whole tool definition — it is not merely skipped, because a router
    // could not know which branch was taken without parsing the body.
    for (const schema of [
      { type: "array", items: { type: "string", "x-mcp-header": "R" } },
      {
        type: "object",
        oneOf: [{ properties: { r: { type: "string", "x-mcp-header": "R" } } }],
      },
      {
        type: "object",
        $defs: { d: { type: "string", "x-mcp-header": "R" } },
      },
      {
        type: "object",
        additionalProperties: { type: "string", "x-mcp-header": "R" },
      },
    ]) {
      expect(scanXMcpHeaderDeclarations(schema).valid).toBe(false);
    }
  });

  it("rejects a name that is not an RFC 9110 token", () => {
    // A space or CR/LF here would be header injection, not a routing hint.
    for (const name of ["has space", "colon:", "cr\r\nlf", ""]) {
      const scan = scanXMcpHeaderDeclarations({
        type: "object",
        properties: { r: { type: "string", "x-mcp-header": name } },
      });
      expect(scan.valid).toBe(false);
    }
  });

  it("rejects a non-primitive property and a duplicate name", () => {
    expect(
      scanXMcpHeaderDeclarations({
        type: "object",
        properties: { r: { type: "object", "x-mcp-header": "R" } },
      }).valid
    ).toBe(false);
    // Header names compare case-insensitively, so these two collide.
    expect(
      scanXMcpHeaderDeclarations({
        type: "object",
        properties: {
          a: { type: "string", "x-mcp-header": "Region" },
          b: { type: "string", "x-mcp-header": "region" },
        },
      }).valid
    ).toBe(false);
  });

  it("accepts `number`, matching the upstream client and the conformance referee", () => {
    // The spec prose excludes `number`, but the published referee's
    // `http-custom-headers` scenario ships two and expects them mirrored.
    // Diverging from upstream here would make us disagree about tool validity.
    const scan = scanXMcpHeaderDeclarations({
      type: "object",
      properties: { ratio: { type: "number", "x-mcp-header": "Ratio" } },
    });
    expect(scan.valid).toBe(true);
  });
});

describe("buildMcpParamHeaders", () => {
  const scanOf = (schema: unknown) => {
    const scan = scanXMcpHeaderDeclarations(schema);
    if (!scan.valid) throw new Error(`unexpected invalid scan: ${scan.reason}`);
    return scan.declarations;
  };

  it("builds the header the 2026 `execute-sql` reference tool requires", () => {
    // Verbatim `inputSchema` from the mcpjam-stateless reference server; this
    // exact header is what turns its -32020 into a result.
    const declarations = scanOf({
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {
        region: {
          type: "string",
          description: "Target region (mirrored to Mcp-Param-Region).",
          "x-mcp-header": "Region",
        },
        query: { type: "string", description: "SQL to execute." },
      },
      required: ["region", "query"],
    });
    expect(
      buildMcpParamHeaders(declarations, { region: "east", query: "hi" })
    ).toEqual({ "Mcp-Param-Region": "east" });
  });

  it("converts primitives the way the server's cross-check expects", () => {
    const declarations = scanOf({
      type: "object",
      properties: {
        s: { type: "string", "x-mcp-header": "S" },
        i: { type: "integer", "x-mcp-header": "I" },
        b: { type: "boolean", "x-mcp-header": "B" },
      },
    });
    expect(
      buildMcpParamHeaders(declarations, { s: "x", i: 42, b: false })
    ).toEqual({
      "Mcp-Param-S": "x",
      "Mcp-Param-I": "42",
      "Mcp-Param-B": "false",
    });
  });

  it("omits a header rather than emitting one the body cannot match", () => {
    // Absent, null, wrong-typed, and unrepresentable values all take the
    // spec's "client MUST omit the header" path. Emitting a malformed header
    // would turn a working call into a -32020.
    const declarations = scanOf({
      type: "object",
      properties: {
        a: { type: "string", "x-mcp-header": "A" },
        b: { type: "string", "x-mcp-header": "B" },
        c: { type: "string", "x-mcp-header": "C" },
        d: { type: "number", "x-mcp-header": "D" },
      },
    });
    expect(
      buildMcpParamHeaders(declarations, {
        b: null,
        c: { nested: true },
        d: Number.POSITIVE_INFINITY,
      })
    ).toEqual({});
  });

  it("encodes a non-ASCII value so it survives as a field value", () => {
    const declarations = scanOf({
      type: "object",
      properties: { region: { type: "string", "x-mcp-header": "Region" } },
    });
    const headers = buildMcpParamHeaders(declarations, { region: "Zürich" });
    expect(decodeMcpHeaderValue(headers["Mcp-Param-Region"]!).value).toBe(
      "Zürich"
    );
  });
});

describe("stripXMcpHeaderAnnotations", () => {
  it("removes a top-level declaration and leaves every other keyword", () => {
    const schema = {
      type: "object",
      required: ["region"],
      properties: {
        region: {
          type: "string",
          description: "shard",
          enum: ["us", "eu"],
          "x-mcp-header": "Region",
        },
      },
    };
    const stripped = stripXMcpHeaderAnnotations(schema) as any;

    expect(scanXMcpHeaderDeclarations(stripped)).toEqual({
      valid: true,
      declarations: [],
    });
    expect(stripped.properties.region).toEqual({
      type: "string",
      description: "shard",
      enum: ["us", "eu"],
    });
    expect(stripped.required).toEqual(["region"]);
    // The input is never mutated — the caller keeps the server's definition.
    expect((schema.properties.region as any)["x-mcp-header"]).toBe("Region");
  });

  it("strips at any nesting depth reachable through `properties`", () => {
    const stripped = stripXMcpHeaderAnnotations({
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: { type: "integer", "x-mcp-header": "Depth" },
          },
        },
      },
    });
    expect(scanXMcpHeaderDeclarations(stripped)).toEqual({
      valid: true,
      declarations: [],
    });
  });

  it("strips declarations parked in NON-reachable positions too", () => {
    // A declaration under `oneOf` makes the tool definition invalid rather
    // than being ignored, so leaving it behind would hand upstream a schema
    // that still trips the validity fault the strip was meant to remove.
    const schema = {
      type: "object",
      properties: {
        choice: {
          oneOf: [{ type: "string", "x-mcp-header": "Bad" }],
        },
        list: {
          type: "array",
          items: { type: "string", "x-mcp-header": "AlsoBad" },
        },
      },
      $defs: { shared: { type: "boolean", "x-mcp-header": "Shared" } },
    };
    expect(scanXMcpHeaderDeclarations(schema).valid).toBe(false);
    expect(scanXMcpHeaderDeclarations(stripXMcpHeaderAnnotations(schema))).toEqual({
      valid: true,
      declarations: [],
    });
  });

  it("returns the input BY REFERENCE when there is nothing to strip", () => {
    // The plain call path runs this on every tools/call under the omit knob;
    // an ordinary tool must not pay a deep copy.
    const schema = {
      type: "object",
      properties: { message: { type: "string" } },
    };
    expect(stripXMcpHeaderAnnotations(schema)).toBe(schema);
  });

  it("passes non-object schemas through untouched", () => {
    expect(stripXMcpHeaderAnnotations(undefined)).toBeUndefined();
    expect(stripXMcpHeaderAnnotations(true)).toBe(true);
  });
});

describe("evaluateMcpHeaders — Mcp-Param-* verdicts", () => {
  const DECLS = [
    { path: ["region"], headerName: "Region", type: "string" },
  ] as const;
  const body = { method: "tools/call", name: "execute-sql", protocolVersion: MODERN };
  const base = {
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": "tools/call",
    "Mcp-Name": "execute-sql",
  };
  const paramRows = (headers: Record<string, string>, check?: any) =>
    evaluateMcpHeaders(headers, body, check).filter((row) => row.family === "param");

  it("is unchecked without the extra facts (unchanged behavior)", () => {
    const rows = paramRows({ ...base, "Mcp-Param-Region": "us-east" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("unchecked");
  });

  it("matches a correctly mirrored argument", () => {
    const rows = paramRows(
      { ...base, "Mcp-Param-Region": "us-east" },
      { declarations: DECLS, arguments: { region: "us-east" } },
    );
    expect(rows).toEqual([
      expect.objectContaining({
        name: "Mcp-Param-Region",
        status: "match",
        bodyField: ".params.arguments.region",
      }),
    ]);
  });

  it("reports a mismatch against the argument the body carried", () => {
    const rows = paramRows(
      { ...base, "Mcp-Param-Region": "eu-west" },
      { declarations: DECLS, arguments: { region: "us-east" } },
    );
    expect(rows[0]).toMatchObject({
      status: "mismatch",
      bodyValue: "us-east",
      bodyField: ".params.arguments.region",
    });
  });

  it("reports a declared-but-unsent header as missing", () => {
    // The knob under test in P1 produces exactly this shape on the wire.
    const rows = paramRows(base, {
      declarations: DECLS,
      arguments: { region: "us-east" },
    });
    expect(rows[0]).toMatchObject({
      name: "Mcp-Param-Region",
      status: "missing",
      bodyValue: "us-east",
    });
  });

  it("treats a correctly omitted header as not-required", () => {
    // No value in arguments ⇒ the spec says the client MUST omit it.
    const rows = paramRows(base, { declarations: DECLS, arguments: {} });
    expect(rows[0]).toMatchObject({
      name: "Mcp-Param-Region",
      status: "not-required",
    });
  });

  it("flags a header sent for an argument that was not passed", () => {
    const rows = paramRows(
      { ...base, "Mcp-Param-Region": "us-east" },
      { declarations: DECLS, arguments: {} },
    );
    expect(rows[0]).toMatchObject({
      status: "mismatch",
      bodyValue: "(absent from arguments)",
    });
  });

  it("flags a param header the tool never declared", () => {
    const rows = paramRows(
      { ...base, "Mcp-Param-Region": "us-east", "Mcp-Param-Ghost": "x" },
      { declarations: DECLS, arguments: { region: "us-east" } },
    );
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["Mcp-Param-Ghost", "undeclared"],
      ["Mcp-Param-Region", "match"],
    ]);
  });

  it("an EMPTY declaration list still decides — every param header is undeclared", () => {
    const rows = paramRows(
      { ...base, "Mcp-Param-Region": "us-east" },
      { declarations: [], arguments: {} },
    );
    expect(rows[0]!.status).toBe("undeclared");
  });

  it("compares decoded values, so a sentinel-encoded header still matches", () => {
    const rows = paramRows(
      { ...base, "Mcp-Param-Region": encodeMcpHeaderValue("東京") },
      { declarations: DECLS, arguments: { region: "東京" } },
    );
    expect(rows[0]).toMatchObject({ status: "match", decoded: "東京" });
  });

  it("resolves a nested declaration path in both the header name and the body field", () => {
    const rows = paramRows(
      { ...base, "Mcp-Param-Shard": "7" },
      {
        declarations: [
          { path: ["routing", "shard"], headerName: "Shard", type: "integer" },
        ],
        arguments: { routing: { shard: 7 } },
      },
    );
    expect(rows[0]).toMatchObject({
      status: "match",
      bodyField: ".params.arguments.routing.shard",
    });
  });

  it("stays unchecked on a legacy request even when facts are supplied", () => {
    // Nothing is mirrored before 2026-07-28; judging it would invent a rule.
    const rows = evaluateMcpHeaders(
      { "MCP-Protocol-Version": "2025-11-25", "Mcp-Param-Region": "us-east" },
      { method: "tools/call", name: "execute-sql", protocolVersion: "2025-11-25" },
      { declarations: DECLS, arguments: { region: "us-east" } },
    ).filter((row) => row.family === "param");
    expect(rows[0]!.status).toBe("unchecked");
  });
});

describe("findMcpHeaderIssues — Mcp-Param-* opt-in", () => {
  const DECLS = [{ path: ["region"], headerName: "Region", type: "string" }];
  const body = { method: "tools/call", name: "t", protocolVersion: MODERN };
  const base = {
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": "tools/call",
    "Mcp-Name": "t",
  };

  it("reports nothing about params without the extra facts", () => {
    expect(
      findMcpHeaderIssues({ ...base, "Mcp-Param-Region": "eu" }, body),
    ).toEqual([]);
  });

  it("reports a param mismatch once declarations are supplied", () => {
    expect(
      findMcpHeaderIssues({ ...base, "Mcp-Param-Region": "eu" }, body, {
        declarations: DECLS,
        arguments: { region: "us" },
      }),
    ).toEqual([
      { kind: "mismatch", header: "Mcp-Param-Region", headerValue: "eu", bodyValue: "us" },
    ]);
  });

  it("reports an undeclared param header", () => {
    expect(
      findMcpHeaderIssues({ ...base, "Mcp-Param-Ghost": "x" }, body, {
        declarations: [],
      }),
    ).toEqual([{ kind: "undeclared", header: "Mcp-Param-Ghost", headerValue: "x" }]);
  });
});
