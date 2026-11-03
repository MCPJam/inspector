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
            readiness: [advice("parse", "MAY"), advice("ttl", "SHOULD")],
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
    expect(header).toHaveTextContent("Additional enhancements5");

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
      "Deprecation notice Apps legacylegacy message",
      "Suggested (SHOULD) Tasks statusstatus message",
      "Suggested (SHOULD) OAuth ississ message",
      "Optional (MAY) Protocol parseparse message",
    ]);
  });
});

describe("reportAdviceGroups", () => {
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
});
