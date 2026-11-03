import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConformanceAdvice } from "../ConformanceAdvice";

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
          { suite: "Tasks", readiness: [advice("status", "SHOULD")] },
          { suite: "OAuth", readiness: [advice("iss", "RECOMMENDED")] },
        ]}
      />,
    );

    const header = screen.getByRole("button", {
      name: /^Additional enhancements/,
    });
    // Closed, with the count, so the score is what a run shows first.
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header).toHaveTextContent("Additional enhancements4");

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
      "Suggested Protocol ttlttl message",
      "Suggested Tasks statusstatus message",
      "Suggested OAuth ississ message",
      "Optional Protocol parseparse message",
    ]);
  });
});
