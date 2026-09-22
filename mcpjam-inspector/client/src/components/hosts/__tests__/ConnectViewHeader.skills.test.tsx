import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Skills is gated by `skills-enabled` in HOSTED mode only: local-mode
// filesystem skills never read the flag, so the tab must stay visible in the
// local app even with the flag off (unlike Computer, which is flagged in both).
let hostedMode = false;
let skillsFlag = false;
let computersFlag = false;

vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => computersFlag,
}));

vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => skillsFlag,
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return hostedMode;
    },
  };
});

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { track } from "@/lib/analytics";
import { ConnectViewHeader } from "../ConnectViewHeader";

const renderHeader = (onChange = () => {}) =>
  render(
    <ConnectViewHeader
      value="servers"
      previewedHostId={null}
      onChange={onChange}
    />
  );

const tabLabels = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll('nav[aria-label="Connect view"] button')
  ).map((button) => button.textContent);

beforeEach(() => {
  hostedMode = false;
  skillsFlag = false;
  computersFlag = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ConnectViewHeader — Skills tab gating", () => {
  it("hides the Skills tab in hosted mode when the flag is off", () => {
    hostedMode = true;
    const { queryByText, getByText } = renderHeader();
    expect(getByText("Servers")).toBeTruthy();
    expect(queryByText("Skills")).toBeNull();
  });

  it("shows the Skills tab in hosted mode when the flag is on, after Computer", () => {
    hostedMode = true;
    skillsFlag = true;
    computersFlag = true;
    const { container, getByText } = renderHeader();
    expect(getByText("Skills")).toBeTruthy();
    expect(tabLabels(container)).toEqual([
      "Servers",
      "Client",
      "Computer",
      "Skills",
    ]);
  });

  it("shows the Skills tab in local mode even with the flag off", () => {
    hostedMode = false;
    skillsFlag = false;
    const { getByText } = renderHeader();
    expect(getByText("Skills")).toBeTruthy();
  });

  it("tracks connect_view_selected and calls onChange when Skills is clicked", () => {
    const onChange = vi.fn();
    const { getByText } = renderHeader(onChange);
    getByText("Skills").click();
    expect(track).toHaveBeenCalledWith("connect_view_selected", {
      from: "servers",
      to: "skills",
    });
    expect(onChange).toHaveBeenCalledWith("skills");
  });
});
