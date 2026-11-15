/**
 * The mark under a copied field: where its answer came from. A default, the
 * account, a confirmation, or who set it and how; a declaration nobody stood
 * behind is called out with a way to confirm it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONNECTOR_FLOW,
  directoryFlowField,
  type DirectoryAnswer,
  type DirectoryFieldIssue,
} from "@mcpjam/sdk/browser";
import { AnswerOrigin, writerOf, type People } from "../AnswerOrigin";

const people: People = {
  you: "user_you",
  nameOf: (id) => (id === "user_pm" ? "Sample Person" : undefined),
};
/** Midday UTC, so the date reads the same in any time zone a test runs in. */
const NOV_12 = Date.UTC(2026, 10, 12, 12);

function field(key: string) {
  const found = directoryFlowField(CLAUDE_CONNECTOR_FLOW, key);
  if (!found) throw new Error(`The Claude flow has no field ${key}`);
  return found;
}

function draw(
  key: string,
  answer: Omit<DirectoryAnswer, "key"> | undefined,
  issue?: DirectoryFieldIssue,
) {
  const onConfirm = vi.fn();
  const view = render(
    <AnswerOrigin
      field={field(key)}
      answer={answer && { key, ...answer }}
      issue={issue}
      people={people}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, ...view };
}

describe("AnswerOrigin", () => {
  it("calls out a declaration still on the portal's default, and confirms it", async () => {
    const { onConfirm } = draw("useCases.access", {
      value: "read-only",
      origin: "default",
    });
    expect(screen.getByText("MCPJam")).toBeVisible();
    expect(screen.getByText("Default")).toBeVisible();
    expect(screen.getByText("Nobody has confirmed this answer.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("marks a default that is not a declaration without asking to confirm it", () => {
    draw("authentication.requirement", { value: "always", origin: "default" });
    expect(screen.getByText("Default")).toBeVisible();
    expect(screen.getByText("The portal preselects it.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("marks an answer the account filled", () => {
    draw("company.contactName", {
      value: "Sample Person",
      origin: "account",
      revision: 1,
    });
    expect(screen.getByText("From your account")).toBeVisible();
    expect(screen.queryByText("Default")).toBeNull();
  });

  it("names who confirmed it, and when", () => {
    draw("dataHandling.healthData", {
      value: "no",
      origin: "confirmed",
      setBy: "user_pm",
      setVia: "web",
      setAt: NOV_12,
    });
    expect(
      screen.getByText("Confirmed by Sample Person in MCPJam on Nov 12, 2026"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("names an agent apart from the person it signed in as, and the channel", () => {
    draw("listing.name", {
      value: "Sample server",
      origin: "set",
      setBy: "user_you",
      setByLabel: "Codex",
      setVia: "api",
      setAt: NOV_12,
    });
    expect(
      screen.getByText(
        "Set by Codex (signed in as you) via the API on Nov 12, 2026",
      ),
    ).toBeVisible();
  });

  it("leaves what the person typed here unmarked, except a declaration", () => {
    const mine = {
      origin: "set",
      setBy: "user_you",
      setVia: "web",
      setAt: NOV_12,
    } as const;
    const { container } = draw("listing.name", { value: "Mine", ...mine });
    expect(container).toBeEmptyDOMElement();

    draw("useCases.access", { value: "read-write", ...mine });
    expect(
      screen.getByText("Set by you in MCPJam on Nov 12, 2026"),
    ).toBeVisible();
  });

  it("marks nothing for an edit this tab has not saved yet", () => {
    const { container } = draw("useCases.access", {
      value: "read-write",
      origin: "set",
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("asks again when a reset put a declaration back, or its wording changed", () => {
    draw("dataHandling.sponsored", {
      value: "no",
      origin: "reset",
      setBy: "user_pm",
      setVia: "cli",
      setAt: NOV_12,
    });
    expect(
      screen.getByText(
        "Reset by Sample Person via the CLI on Nov 12, 2026. Nobody has confirmed it since.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeVisible();
  });

  it("offers to confirm again when the wording changed after a confirmation", () => {
    draw(
      "useCases.access",
      {
        value: "read-write",
        origin: "confirmed",
        setBy: "user_pm",
        setAt: NOV_12,
      },
      {
        key: "useCases.access",
        step: "useCases",
        code: "wordingChanged",
        message: "The wording changed after this was confirmed.",
      },
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeVisible();
  });

  it("names a principal it cannot resolve as a project member", () => {
    expect(writerOf(people, "user_gone")).toBe("a project member");
    expect(writerOf(people, undefined, "Slack")).toBe(
      "Slack (signed in as a project member)",
    );
  });
});
