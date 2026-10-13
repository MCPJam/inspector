import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, type Mock } from "vitest";
import App from "../App";

const command = 'npx -y server-example --label "hello world"';

export function registerFirstRunValidationCases(
  prepare: (hosted: boolean) => { handleConnect: Mock; track: Mock },
) {
  const start = createStart(prepare);

  it("rejects hosted STDIO again on retry and accepts a corrected HTTPS URL", async () => {
    const { handleConnect, track } = await start(command);
    await screen.findByRole("heading", { name: "Set up your server" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Connect your STDIO server",
    );
    expect(
      screen.queryByRole("button", { name: "View technical details" }),
    ).toBeNull();
    expect(handleConnect).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(
      "first_run_onboarding_connection_failed",
      expect.objectContaining({
        transport: "stdio",
        failure_stage: "validation",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
    expect(handleConnect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "https://mcp.example.com/mcp" },
    });
    expect(screen.getByRole("combobox", { name: "Transport" })).toHaveValue(
      "http",
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
    await waitFor(() => expect(handleConnect).toHaveBeenCalled());
    expect(handleConnect.mock.lastCall?.[0]).toMatchObject({
      type: "http",
      url: "https://mcp.example.com/mcp",
    });
  });

  it.each(["mcp.example.com/mcp", "localhost:3000/mcp", "ftp://host"])(
    "gives URL guidance for %s without suggesting a local install",
    async (input) => {
      const { handleConnect, track } = await start(input);
      await screen.findByRole("heading", { name: "Set up your server" });
      expect(screen.getByRole("alert")).toHaveTextContent(/URL/);
      expect(
        screen.queryByRole("region", { name: "Run MCPJam locally" }),
      ).toBeNull();
      expect(handleConnect).not.toHaveBeenCalled();
      expect(track).toHaveBeenCalledWith(
        "first_run_onboarding_connection_failed",
        expect.objectContaining({
          transport: "http",
          failure_stage: "validation",
        }),
      );
    },
  );

  registerLocalCase(start);
}

function registerLocalCase(start: ReturnType<typeof createStart>) {
  it("preserves quoted STDIO arguments through local onboarding", async () => {
    const { handleConnect, track } = await start(command, false);
    await waitFor(() => expect(handleConnect).toHaveBeenCalled());
    expect(handleConnect.mock.lastCall?.[0]).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["-y", "server-example", "--label", "hello world"],
    });
    expect(handleConnect.mock.lastCall?.[1]).toMatchObject({
      suppressErrorToast: true,
      suppressSuccessToast: true,
    });
    expect(track).toHaveBeenCalledWith(
      "first_run_onboarding_connection_started",
      expect.objectContaining({ transport: "stdio" }),
    );
  });
}

function createStart(
  prepare: (hosted: boolean) => { handleConnect: Mock; track: Mock },
) {
  return async (input: string, hosted = true) => {
    const mocks = prepare(hosted);
    render(<App />);
    await screen.findByRole("heading", { name: "Welcome to MCPJam" });
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: input },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    return mocks;
  };
}
