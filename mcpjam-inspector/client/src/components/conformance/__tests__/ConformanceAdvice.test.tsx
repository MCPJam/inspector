import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConformanceAdvice, reportAdviceGroups } from "../ConformanceAdvice";

/** A row's lines: the heading (strength, suite, title), then its detail. */
const rowLines = (row: HTMLElement) =>
  Array.from(row.querySelectorAll(":scope > span:last-child > span")).map(
    (line) => line.textContent,
  );

const advice = (id: string, specStrength: string) => ({
  id,
  title: id,
  specStrength,
  message: `${id} message`,
});

describe("ConformanceAdvice", () => {
  it("renders nothing when no suite has advice", () => {
    const { container } = render(
      <ConformanceAdvice
        groups={[{ suite: "Protocol" }, { suite: "Tasks" }]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("collects every suite's advice in one closed list, Suggested first", () => {
    render(
      <ConformanceAdvice
        groups={[
          {
            suite: "Protocol",
            readiness: [
              advice("parse", "MAY"),
              advice("ttl", "SHOULD"),
              advice("deprecated", "Deprecation Notice"),
            ],
          },
          {
            suite: "Apps",
            readiness: [advice("legacy", "Deprecation Notice")],
          },
          { suite: "Tasks", readiness: [advice("status", "SHOULD")] },
          { suite: "OAuth", readiness: [advice("iss", "SHOULD")] },
        ]}
      />,
    );

    const header = screen.getByRole("button", {
      name: /^Additional enhancements/,
    });
    // Closed, with the count, so the score is what a run shows first.
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header).toHaveTextContent("Additional enhancements6");
    expect(
      screen.queryByText(/A deprecation notice means the spec/),
    ).not.toBeInTheDocument();

    // The spec words link to their definitions, outside the toggle.
    for (const [word, section] of [
      ["SHOULD", 3],
      ["MAY", 5],
    ] as const) {
      expect(screen.getByRole("link", { name: word })).toHaveAttribute(
        "href",
        `https://www.rfc-editor.org/info/rfc2119/#section-${section}`,
      );
    }

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getAllByRole("listitem").map((row) => row.textContent),
    ).toEqual([
      "Suggested (SHOULD) Protocol ttlttl message",
      "Suggested (Deprecated) Protocol deprecateddeprecated message",
      "Suggested (Deprecated) Apps legacylegacy message",
      "Suggested (SHOULD) Tasks statusstatus message",
      "Suggested (SHOULD) OAuth ississ message",
      "Optional (MAY) Protocol parseparse message",
    ]);
  });
});

describe("ConformanceAdvice passed advice", () => {
  const met = (id: string, specStrength: string) => ({
    id,
    title: `${id} title`,
    specStrength,
  });

  it("lists advice the server meets after the advice to act on, in green with a check", () => {
    render(
      <ConformanceAdvice
        groups={[
          {
            suite: "Protocol",
            readiness: [advice("ttl", "SHOULD")],
            passed: [
              met("readiness-log-level-filtering", "MAY"),
              met("readiness-tool-order-deterministic", "SHOULD"),
            ],
          },
          {
            suite: "OAuth",
            passed: [met("readiness-oauth-iss-advertised", "SHOULD")],
          },
        ]}
      />,
    );

    const header = screen.getByRole("button", {
      name: /^Additional enhancements/,
    });
    expect(header).toHaveTextContent("Additional enhancements13 passed");
    fireEvent.click(header);

    const rows = screen.getAllByRole("listitem");
    // Each row as [heading line, detail line].
    expect(rows.map(rowLines)).toEqual([
      ["Suggested (SHOULD) Protocol ttl", "ttl message"],
      // A passed row has no message, so it says what the advice asks for.
      [
        "Suggested (SHOULD) Protocol readiness-tool-order-deterministic title",
        "tools/list returns the tools in the same order on every call.",
      ],
      [
        "Suggested (SHOULD) OAuth readiness-oauth-iss-advertised title",
        "The authorization server advertises authorization_response_iss_parameter_supported.",
      ],
      [
        "Optional (MAY) Protocol readiness-log-level-filtering title",
        "A tool called at a log level sends logs at or above that level.",
      ],
    ]);
    // Advice to act on keeps the blue info icon and label; a pass turns green.
    expect(rows[0].querySelector("span.font-medium")).toHaveClass("text-info");
    const passedLabel = rows[1].querySelector("span.font-medium");
    expect(passedLabel).toHaveClass("text-emerald-700");
    expect(passedLabel).not.toHaveClass("text-info");
    expect(rows[0].querySelector("svg.text-info")).not.toBeNull();
    expect(rows[1].querySelector("svg.text-info")).toBeNull();
    expect(rows[1].querySelector("[class*=\"bg-emerald-500\"]")).not.toBeNull();
  });

  it("says what a passed Apps advice asks for, and nothing for an unknown id", () => {
    render(
      <ConformanceAdvice
        groups={[
          {
            suite: "Apps",
            passed: [
              met("apps-readiness-deprecated-resource-uri", "Deprecation Notice"),
              // A saved report is untrusted: no prototype key may become text.
              met("__proto__", "SHOULD"),
            ],
          },
        ]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Additional enhancements/ }),
    );

    expect(screen.getAllByRole("listitem").map(rowLines)).toEqual([
      [
        "Suggested (Deprecated) Apps apps-readiness-deprecated-resource-uri title",
        'UI tools point at their resource with _meta.ui.resourceUri, not the deprecated flat _meta["ui/resourceUri"].',
      ],
      ["Suggested (SHOULD) Apps __proto__ title"],
    ]);
  });

  it("shows the section when every advice passed", () => {
    render(
      <ConformanceAdvice
        groups={[
          {
            suite: "Protocol",
            passed: [met("readiness-tool-order-deterministic", "SHOULD")],
          },
        ]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Additional enhancements/ }),
    ).toHaveTextContent("Additional enhancements1 passed");
  });
});

describe("reportAdviceGroups", () => {
  it("reads a saved report's passed advisories", () => {
    expect(
      reportAdviceGroups([
        {
          suiteKind: "protocol",
          passedAdvisories: [
            {
              id: "readiness-tool-order-deterministic",
              title: "Deterministic Tool Order",
              group: "mcp-1",
              status: "SHOULD",
            },
            { id: 3 },
          ],
        },
      ]),
    ).toEqual([
      {
        suite: "Protocol",
        readiness: [],
        passed: [
          {
            id: "readiness-tool-order-deterministic",
            title: "Deterministic Tool Order",
            specStrength: "SHOULD",
          },
        ],
      },
    ]);
  });

  it.each(["SHOULD", "Deprecation Notice"])(
    "labels saved protocol deprecation with strength %s as Suggested (Deprecated)",
    (status) => {
      const reports = [
        {
          suiteKind: "protocol",
          advisories: [
            {
              id: "readiness-deprecated-feature-use",
              title: "Deprecated Feature Use",
              kind: "readiness",
              status,
              message: "The negotiated revision is superseded.",
            },
          ],
        },
      ];
      const groups = reportAdviceGroups(reports);
      expect(groups[0].readiness?.[0].specStrength).toBe("Deprecation Notice");
      expect(reports[0].advisories[0].status).toBe(status);

      render(<ConformanceAdvice groups={groups} />);
      fireEvent.click(
        screen.getByRole("button", { name: /^Additional enhancements/ }),
      );
      expect(screen.getByRole("listitem")).toHaveTextContent(
        "Suggested (Deprecated) Protocol Deprecated Feature Use",
      );
      expect(screen.getByRole("listitem")).not.toHaveTextContent("SHOULD");
      expect(
        screen.queryByText(/A deprecation notice means the spec/),
      ).not.toBeInTheDocument();
    },
  );

  it("reads a saved report's readiness advisories as advice rows", () => {
    expect(
      reportAdviceGroups([
        {
          suiteKind: "oauth",
          advisories: [
            {
              id: "readiness-oauth-iss-advertised",
              title: "Advertise iss",
              kind: "readiness",
              status: "SHOULD",
              message: "Set authorization_response_iss_parameter_supported.",
            },
            // Not a suite's advice: a directory-readiness finding.
            { id: "x", title: "x", kind: "insight", status: "warn" },
          ],
        },
        { suiteKind: "protocol" },
      ]),
    ).toEqual([
      {
        suite: "OAuth",
        readiness: [
          {
            id: "readiness-oauth-iss-advertised",
            title: "Advertise iss",
            specStrength: "SHOULD",
            message: "Set authorization_response_iss_parameter_supported.",
          },
        ],
      },
      { suite: "Protocol", readiness: [] },
    ]);
  });

  it("ignores advisories that are not a list of objects", () => {
    expect(
      reportAdviceGroups([
        { suiteKind: "protocol", advisories: "not a list" },
        { suiteKind: "tasks", advisories: [null, 3, "x"] },
      ]),
    ).toEqual([
      { suite: "Protocol", readiness: [] },
      { suite: "Tasks", readiness: [] },
    ]);
  });
});
