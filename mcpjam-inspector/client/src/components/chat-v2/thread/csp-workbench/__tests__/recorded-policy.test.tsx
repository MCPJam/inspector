import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CspWorkbench } from "../CspWorkbench";

describe("CspWorkbench recorded policy", () => {
  it("reuses the policy and sandbox views without claiming live evidence", async () => {
    const user = userEvent.setup();
    render(
      <CspWorkbench
        protocol="mcp-apps"
        recordedPolicy={{
          resourceUri: "ui://widget/create-view.html",
          csp: { connectDomains: ["https://api.example.com"] },
          permissions: { clipboardWrite: {} },
          permissive: false,
          prefersBorder: true,
          consoleErrors: ["TypeError: broken"],
          blockedRequests: ["https://blocked.example.com"],
        }}
      />,
    );

    expect(screen.getByText("Recorded widget policy")).toBeInTheDocument();
    expect(screen.getByText("2 recorded errors")).toBeInTheDocument();
    expect(screen.getByText("TypeError: broken")).toBeInTheDocument();
    expect(screen.getByText("https://blocked.example.com")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Findings" })).toBeNull();
    expect(screen.getAllByText("Not recorded")).toHaveLength(2);

    await user.click(screen.getByRole("tab", { name: "Sandbox Stack" }));
    expect(
      screen.getByText("ui://widget/create-view.html"),
    ).toBeInTheDocument();
    expect(screen.getByText("clipboard-write")).toBeInTheDocument();
    expect(screen.getByText("restricted")).toBeInTheDocument();
    expect(screen.getByText("yes")).toBeInTheDocument();
    expect(screen.getByText("not recorded")).toBeInTheDocument();
  });

  it("shows missing old snapshot fields as unavailable instead of null JSON", () => {
    render(<CspWorkbench protocol="mcp-apps" recordedPolicy={{}} />);

    expect(screen.getByText("No CSP declared")).toBeInTheDocument();
    expect(screen.queryByText('"resourceUri": null')).toBeNull();
  });
});
