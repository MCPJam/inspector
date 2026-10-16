import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { LocalStudyControls } from "../LocalStudyControls";
import type { LocalStudyController } from "@/hooks/use-local-study-target";
const setup = vi.fn(async () => {});
const cloud = vi.fn();
const controller = (
  extra: Partial<LocalStudyController> = {},
): LocalStudyController => ({
  key: "actor-study",
  requested: false,
  loading: false,
  error: null,
  setup,
  useCloud: cloud,
  resolveSendTarget: () => null,
  ...extra,
});
beforeEach(() => {
  vi.clearAllMocks();
});
it("asks permission and performs setup only after explicit confirmation", async () => {
  render(
    <LocalStudyControls
      controller={controller()}
      chatSessionId="chat"
      disabled={false}
    />,
  );
  expect(screen.getByText("Cloud")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Run on this machine" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("OS user");
  expect(screen.getByRole("dialog")).toHaveTextContent("without asking again");
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "saved model source and billing",
  );
  expect(screen.getByRole("dialog")).toHaveTextContent("press Send");
  expect(setup).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Authorize local preview" }),
  );
  await waitFor(() => expect(setup).toHaveBeenCalledWith("chat"));
});
it("cancel keeps the existing venue and never authorizes", () => {
  render(
    <LocalStudyControls
      controller={controller()}
      chatSessionId="chat"
      disabled={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Run on this machine" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(setup).not.toHaveBeenCalled();
  expect(screen.getByText("Cloud")).toBeInTheDocument();
});
it("shows unavailable and actionable failure without implying a cloud fallback", () => {
  render(
    <LocalStudyControls
      controller={controller({
        requested: true,
        error: "Choose and save a model source",
      })}
      chatSessionId="chat"
      disabled={false}
    />,
  );
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Choose and save");
  fireEvent.click(screen.getByRole("button", { name: "Use cloud" }));
  expect(cloud).toHaveBeenCalledOnce();
});
it("prevents switching venues during an active turn", () => {
  render(
    <LocalStudyControls
      controller={controller({ requested: true })}
      chatSessionId="chat"
      disabled
    />,
  );
  expect(screen.getByRole("button", { name: "Local setup" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Use cloud" })).toBeDisabled();
});
