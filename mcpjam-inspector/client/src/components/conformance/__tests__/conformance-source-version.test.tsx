import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

import { CatalogList, CheckRow } from "../ConformanceCheckRows";
import { ConformanceCheckPicker } from "../ConformanceCheckPicker";
import { suiteCatalog } from "../conformance-catalogs";
import { SuiteList, sourceVersionOf } from "../conformance-source-version";

const LEGACY_TOKEN_HANDLING =
  "https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#token-handling";
const tokenHandlingLinks = () =>
  screen
    .getAllByRole("link", { hidden: true })
    .map((link) => link.getAttribute("href") ?? "")
    .filter((href) => href.endsWith("#token-handling"));

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

describe("catalog links follow the revision", () => {
  it("links a saved run's not-applicable suite in the run's revision", () => {
    render(
      <SuiteList version="2025-11-25">
        <CatalogList catalog={suiteCatalog("oauth")} />
      </SuiteList>,
    );
    expect(tokenHandlingLinks()).toEqual([LEGACY_TOKEN_HANDLING]);
  });

  it("links the pinned revision before a run", () => {
    render(
      <ConformanceCheckPicker
        versionPin="2025-11-25"
        selection={{}}
        onChange={() => {}}
        defaultOpen
      />,
    );
    expect(tokenHandlingLinks()).toEqual([LEGACY_TOKEN_HANDLING]);
  });
});
