import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AddServerModal } from "../AddServerModal";
import type { ServerConnectionSubmit } from "@/lib/server-connection-submission";

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock("@/hooks/use-app-ready", () => ({
  useAppReady: () => ({ status: "ready" }),
  useAppReadyMessage: () => null,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const initialData = {
  name: "Asana",
  type: "http" as const,
  url: "https://example.com/mcp",
};
const submit = () =>
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

it("keeps the full draft open when saving is rejected", async () => {
  const onClose = vi.fn();
  render(
    <AddServerModal
      isOpen
      initialData={initialData}
      onClose={onClose}
      onSubmit={async () => {
        throw new Error("raw response body");
      }}
    />,
  );
  submit();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your draft is still here",
  );
  expect(screen.getByDisplayValue("Asana")).toBeInTheDocument();
  expect(screen.getByDisplayValue(initialData.url)).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByText("raw response body")).not.toBeInTheDocument();
});

it("only closes after the submission owner accepts the saved configuration", async () => {
  const onClose = vi.fn();
  const onSubmit: ServerConnectionSubmit = (_data, options) => {
    options?.onAccepted?.();
  };
  render(
    <AddServerModal
      isOpen
      initialData={initialData}
      onClose={onClose}
      onSubmit={onSubmit}
    />,
  );
  submit();
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

it("puts a missing server name beside its control rather than in a toast", async () => {
  const onSubmit = vi.fn();
  render(
    <AddServerModal
      isOpen
      initialData={{ ...initialData, name: "" }}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  submit();
  expect(await screen.findByText("Enter a server name.")).toHaveAttribute(
    "id",
    "add-server-name-error",
  );
  expect(
    document.querySelector('[aria-describedby="add-server-name-error"]'),
  ).toHaveAttribute("aria-invalid", "true");
  expect(onSubmit).not.toHaveBeenCalled();
});
