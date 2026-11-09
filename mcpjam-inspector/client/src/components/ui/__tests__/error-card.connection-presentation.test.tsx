import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ErrorCard } from "../error-card";
import { presentConnectionError } from "@/lib/connection-error-presentation";

it("shows reviewed copy, recovery and separate Copy details before opening diagnostics", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const onClick = vi.fn();
  const input = {
    message: "Guest client secret reveal is not supported",
    requestId: "request-123",
    code: "SIGN_IN_REQUIRED",
  };
  render(
    <ErrorCard
      error={input}
      presentation={presentConnectionError(input, { serverName: "Asana" })}
      density="row"
      action={{ label: "Sign in", onClick }}
    />,
  );

  expect(screen.getByText("Couldn't connect to Asana.")).toBeInTheDocument();
  expect(
    screen.getByText("Sign in to MCPJam to continue."),
  ).toBeInTheDocument();
  expect(screen.queryByText(input.message)).not.toBeInTheDocument();
  expect(screen.getByTestId("error-card-details")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(onClick).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("request-123"),
    ),
  );
  fireEvent.click(screen.getByTestId("error-card-details"));
  expect(screen.getByText(input.message)).toBeInTheDocument();
});
