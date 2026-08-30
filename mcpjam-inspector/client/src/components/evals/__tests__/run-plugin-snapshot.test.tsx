/**
 * The run's pinned-plugin row, and the "skills excluded" badge that rides on it.
 *
 * The badge marks the without-skills arm of a comparison — and that arm very
 * often pins no plugins at all, which is exactly the case an early return on an
 * empty plugin list used to swallow. These tests pin the reachability down so
 * the two conditions can't be collapsed back into one.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunPluginSnapshot } from "../run-plugin-snapshot";

describe("RunPluginSnapshot", () => {
  it("says nothing when there are no plugins and nothing else to report", () => {
    // Absence is semantic: an empty "Plugins" row would read like a failure to
    // load one.
    const { container } = render(<RunPluginSnapshot pluginVersions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the skills-excluded badge even with no pinned plugins", () => {
    render(<RunPluginSnapshot pluginVersions={[]} skillsExcluded />);
    expect(screen.getByText("skills excluded")).toBeInTheDocument();
    // Nothing to label — the row carries only the badge.
    expect(screen.queryByText("Plugins")).not.toBeInTheDocument();
  });

  it("labels pinned plugins, and carries the badge alongside them", () => {
    render(
      <RunPluginSnapshot
        pluginVersions={[
          {
            pluginId: "plug-1",
            pluginVersionId: "ver-1",
            name: "billing",
            bundleHash: "abcdef1234567890",
          },
        ]}
        skillsExcluded
      />,
    );
    expect(screen.getByText("Plugins")).toBeInTheDocument();
    expect(screen.getByText("billing")).toBeInTheDocument();
    expect(screen.getByText("skills excluded")).toBeInTheDocument();
  });
});
