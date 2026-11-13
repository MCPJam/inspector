import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CheckRow } from "../ConformanceCheckRows";
import { SuiteList, sourceVersionOf } from "../conformance-source-version";

describe("sourceVersionOf", () => {
  it("prefers the scored version, then the negotiated one, then the pin", () => {
    expect(
      sourceVersionOf(
        {
          pooledScore: { protocolVersion: "2026-07-28" },
          resolvedProtocolVersion: "2025-11-25",
        },
        "2025-06-18",
      ),
    ).toBe("2026-07-28");
    expect(
      sourceVersionOf({ resolvedProtocolVersion: "2025-11-25" }, "2025-06-18"),
    ).toBe("2025-11-25");
    expect(sourceVersionOf({}, "2025-06-18")).toBe("2025-06-18");
    expect(sourceVersionOf({}, "auto")).toBeUndefined();
  });
});

describe("SuiteList", () => {
  it("tells the rows inside it which revision to link", () => {
    render(
      <SuiteList version="2025-11-25">
        <CheckRow
          check={{
            id: "tools-list",
            title: "Tools List",
            status: "passed",
          }}
        />
      </SuiteList>,
    );
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools",
    );
  });
});
