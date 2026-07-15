import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let flagEnabled = false;
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => flagEnabled,
}));

import { ConnectViewHeader } from "../ConnectViewHeader";

afterEach(() => {
  flagEnabled = false;
});

describe("ConnectViewHeader — Computer tab gating", () => {
  it("hides the Computer tab when the flag is off", () => {
    flagEnabled = false;
    const { queryByText, getByText } = render(
      <ConnectViewHeader
        value="servers"
        previewedHostId={null}
        onChange={() => {}}
      />
    );
    expect(getByText("Servers")).toBeTruthy();
    expect(queryByText("Computer")).toBeNull();
  });

  it("shows the Computer tab when the flag is on", () => {
    flagEnabled = true;
    const { getByText } = render(
      <ConnectViewHeader
        value="servers"
        previewedHostId={null}
        onChange={() => {}}
      />
    );
    expect(getByText("Computer")).toBeTruthy();
  });
});
