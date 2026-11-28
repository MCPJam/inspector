import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FeatureDetail } from "../FeatureDetail";
import { formatEvidenceTime } from "../feature-states";
import { buildFeatureCards, resolveFeatureSelection } from "../feature-tree";
import {
  CAPTURED_AT,
  SERVER_FEATURE_CATALOG,
  evaluate,
  storedEvidence,
} from "./fixtures";

const evaluation = evaluate(storedEvidence(), {
  connected: true,
  checks: [
    {
      ref: "protocol:server-initialize",
      status: "failed",
      runId: "run_7",
      runAt: CAPTURED_AT + 1000,
      protocolVersion: "2025-11-25",
    },
  ],
});
const cards = buildFeatureCards(SERVER_FEATURE_CATALOG, evaluation);
const families = cards.flatMap((card) => card.families);

function renderDetail(id: string) {
  const selection = resolveFeatureSelection(id, SERVER_FEATURE_CATALOG)!;
  const familyId = selection.family.id;
  const handlers = {
    onClose: vi.fn(),
    onSelect: vi.fn(),
    onAction: vi.fn(),
    onOpenRun: vi.fn(),
  };
  render(
    <FeatureDetail
      selection={selection}
      assessment={
        selection.kind === "feature"
          ? evaluation.assessments[selection.feature.id]
          : undefined
      }
      familyModel={families.find((family) => family.family.id === familyId)}
      cardName="Server Features"
      {...handlers}
    />,
  );
  return handlers;
}

describe("FeatureDetail", () => {
  it("explains a supported feature with each piece of evidence and its time", () => {
    renderDetail("tools.list");
    const detail = screen.getByTestId("feature-detail");
    expect(within(detail).getByRole("heading", { name: "tools/list" })).toBeInTheDocument();
    expect(within(detail).getByText("Server Features · Tools")).toBeInTheDocument();
    expect(within(detail).getByText("Supported")).toBeInTheDocument();
    expect(within(detail).getByText("Who provides it")).toBeInTheDocument();
    expect(within(detail).getByText("The server")).toBeInTheDocument();
    expect(within(detail).getByText("Seen in use")).toBeInTheDocument();
    expect(within(detail).getByText("Seen 3 times")).toBeInTheDocument();
    expect(
      within(detail).getAllByText(formatEvidenceTime(CAPTURED_AT)).length,
    ).toBeGreaterThan(0);
    expect(within(detail).getByText("How to add it")).toBeInTheDocument();
    const feature = SERVER_FEATURE_CATALOG.find((f) => f.id === "tools.list")!;
    expect(within(detail).getByText(feature.howTo)).toBeInTheDocument();
    expect(
      within(detail).getByRole("link", { name: "Read the specification" }),
    ).toHaveAttribute("href", feature.spec.url);
  });

  it("names what limits a could-add assessment and offers no action it lacks", () => {
    renderDetail("prompts.capability");
    const detail = screen.getByTestId("feature-detail");
    expect(within(detail).getByText("Could add")).toBeInTheDocument();
    expect(within(detail).getByText("Not found")).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Run checks" })).toBeNull();
  });

  it("links a failed check to its run and offers to run checks again", () => {
    const handlers = renderDetail("server-info.name-version");
    const detail = screen.getByTestId("feature-detail");
    expect(within(detail).getByText("Check failed")).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: /Open run/ }));
    expect(handlers.onOpenRun).toHaveBeenCalledWith("run_7");
    fireEvent.click(within(detail).getByRole("button", { name: "Run checks" }));
    expect(handlers.onAction).toHaveBeenCalledWith("run-checks");
  });

  it("shows how to test a feature the server does not provide", () => {
    renderDetail("client.sampling");
    expect(screen.getByText("How to test it")).toBeInTheDocument();
    expect(screen.getByText("The client")).toBeInTheDocument();
    expect(screen.getByText("Depends on the client")).toBeInTheDocument();
    expect(screen.queryByText("Needs a newer version or client")).toBeNull();
  });

  it("names a newer protocol version only when the feature is newer", () => {
    renderDetail("tasks.ext");
    expect(
      screen.getByText("Needs a newer protocol version"),
    ).toBeInTheDocument();
  });

  it("gives a parent the cause its rows share", () => {
    renderDetail("auth-ext.xaa");
    expect(
      screen.getByText("Depends on the identity provider"),
    ).toBeInTheDocument();
    cleanup();
    renderDetail("authorization-extensions");
    const rows = within(screen.getByTestId("feature-detail")).getAllByRole(
      "listitem",
    );
    const chip = (name: string) =>
      rows.find((row) =>
        within(row)
          .getAllByRole("button")[0]
          .getAttribute("aria-label")
          ?.startsWith(`${name},`),
      );
    expect(chip("Enterprise-Managed Authorization (XAA)")).toHaveTextContent(
      "↗ Depends on identity provider",
    );
    expect(chip("SAML assertion to ID-JAG")).toHaveTextContent(
      "↗ Depends on identity provider",
    );
    expect(chip("Client credentials token request")).toHaveTextContent(
      "↗ Depends on client",
    );
  });

  it("shows a family's counts and features, each selectable", () => {
    const handlers = renderDetail("prompts");
    const detail = screen.getByTestId("feature-detail");
    expect(within(detail).getByRole("heading", { name: "Prompts" })).toBeInTheDocument();
    expect(within(detail).getAllByRole("listitem")).toHaveLength(7);
    fireEvent.click(
      within(detail).getByRole("button", { name: /^prompts capability,/ }),
    );
    expect(handlers.onSelect).toHaveBeenCalledWith("prompts.capability");
  });

  it("closes", () => {
    const handlers = renderDetail("tools.list");
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(handlers.onClose).toHaveBeenCalled();
  });
});
