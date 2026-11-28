import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunCliVersionNotice } from "../run-cli-version-notice";

afterEach(cleanup);

describe("run CLI version notice", () => {
  it("explains older reporting without claiming stored results are missing", () => {
    render(
      <RunCliVersionNotice
        run={{ launcher: { kind: "cli", version: "6.0.1" } }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("older CLI (6.0.1)");
    expect(screen.getByText(/Local HTML and JUnit/)).toHaveTextContent(
      "can omit tool calls, tokens and scores",
    );
    expect(
      screen.getByText("npm install -g @mcpjam/cli@latest"),
    ).toBeInTheDocument();
  });

  it.each([undefined, "", "unknown", "6.4.1", "6.4.4", "7.0.0"])(
    "stays quiet for unknown or supported CLI %s",
    (version) => {
      render(
        <RunCliVersionNotice run={{ launcher: { kind: "cli", version } }} />,
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("does not treat another program's version as the CLI version", () => {
    render(
      <RunCliVersionNotice
        run={{ launcher: { kind: "mcp", client: "agent", version: "1.0.0" } }}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
