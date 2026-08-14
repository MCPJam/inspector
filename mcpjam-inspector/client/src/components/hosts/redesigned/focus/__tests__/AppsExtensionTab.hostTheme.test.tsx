import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: () => <textarea aria-label="json" readOnly />,
}));

import { AppsExtensionTab } from "../AppsExtensionTab";

describe("AppsExtensionTab host theme browser", () => {
  it("renders the token browser when hostContext.styles.variables exist", () => {
    const draft = emptyHostConfigInputV2({
      hostContext: {
        styles: {
          variables: {
            "--color-background-primary":
              "light-dark(rgba(255, 255, 255, 1), rgba(48, 48, 46, 1))",
          },
        },
      },
    });
    render(
      <AppsExtensionTab
        draft={draft}
        onDraftChange={() => undefined}
        attention={[]}
      />,
    );
    expect(screen.getByTestId("host-theme-token-browser")).toBeInTheDocument();
    expect(screen.getByText("--color-background-primary")).toBeInTheDocument();
  });

  it("shows the Claude registry when the draft hostStyle is claude", () => {
    const draft = emptyHostConfigInputV2({
      hostStyle: "claude",
      hostContext: {
        styles: {
          variables: {
            "--color-background-primary":
              "light-dark(rgba(255, 255, 255, 1), rgba(48, 48, 46, 1))",
            "--border-radius-lg": "10px",
          },
        },
      },
    });
    render(
      <AppsExtensionTab
        draft={draft}
        onDraftChange={() => undefined}
        attention={[]}
      />,
    );
    expect(screen.getByLabelText("Watch host theme")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Tokens" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Diff" })).toBeInTheDocument();
    expect(screen.queryByTestId("host-theme-diff")).not.toBeInTheDocument();
  });
});
