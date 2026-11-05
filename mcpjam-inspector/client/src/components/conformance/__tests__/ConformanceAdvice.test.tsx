import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConformanceAdvice, reportAdviceGroups } from "../ConformanceAdvice";

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
    for (const word of ["SHOULD", "MAY"]) {
      expect(screen.getByRole("link", { name: word })).toHaveAttribute(
        "href",
        "https://datatracker.ietf.org/doc/html/bcp14",
      );
    }

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getAllByRole("listitem").map((row) => row.textContent),
    ).toEqual([
      "Suggested (SHOULD) Protocol ttlttl message",
      "Suggested Protocol deprecateddeprecated message",
      "Suggested Apps legacylegacy message",
      "Suggested (SHOULD) Tasks statusstatus message",
      "Suggested (SHOULD) OAuth ississ message",
      "Optional (MAY) Protocol parseparse message",
    ]);
  });
});

describe("reportAdviceGroups", () => {
  it.each(["SHOULD", "Deprecation Notice"])(
    "renders saved protocol deprecation with strength %s using the short label",
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
        "Suggested Protocol Deprecated Feature Use",
      );
      expect(screen.getByRole("listitem")).not.toHaveTextContent("Suggested (");
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
