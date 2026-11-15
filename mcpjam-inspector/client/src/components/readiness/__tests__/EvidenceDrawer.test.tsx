/**
 * One result's evidence. Opened from the result, the drawer says what the
 * check read, whether that evidence still holds, the run that reached it,
 * the rule it cites and the next step, and shows the observation stored with
 * it, read from the finding-detail route.
 */
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claudePolicySource, type PlacedFinding } from "@mcpjam/sdk/browser";
import type { StoredFinding } from "@/lib/apis/directory-submissions-api";
import { EvidenceDrawer } from "../EvidenceDrawer";
import { McpjamChecks } from "../McpjamChecks";
import { OpenEvidence } from "../ShowEvidence";
import { finding, flow, LISTING_FIELDS, SCOPE } from "./readiness-fixtures";

const api = vi.hoisted(() => ({ getSubmissionFinding: vi.fn() }));
vi.mock("@/lib/apis/directory-submissions-api", () => api);

const listing: PlacedFinding = {
  finding: finding(LISTING_FIELDS),
  step: "listing",
  evidenceStatus: "established",
};

const redirects: PlacedFinding = {
  finding: finding("claude.endpoint.redirects-stay-https", {
    title: "Redirects stay on https",
    status: "satisfied",
    remediation: undefined,
    provenance: "wire",
    source: claudePolicySource("troubleshooting", "Redirects"),
  }),
  step: "connection",
  field: "connection.serverUrl",
  evidenceStatus: "stale",
  staleBecause: ["connection.serverUrl"],
};

function stored(overrides: Partial<StoredFinding> = {}): StoredFinding {
  return {
    checkId: LISTING_FIELDS,
    runId: "run_7",
    step: "listing",
    lane: "submission-artifacts",
    class: "required",
    status: "violated",
    title: listing.finding.title,
    provenance: "declared",
    evaluatedAt: Date.UTC(2026, 10, 13, 10, 42),
    engineVersion: "1.4.0",
    updatedAt: 1,
    hasDetails: true,
    inputs: [
      { kind: "answer", key: "listing.name", fingerprint: "f1" },
      { kind: "answer", key: "listing.oneLiner", fingerprint: "f2" },
    ],
    details: { oneLiner: { length: 240, limit: 200 } },
    ...overrides,
  };
}

/** The page's wiring: a result opens the drawer, which closes itself. */
function Results({ entries }: { entries: PlacedFinding[] }) {
  const [open, setOpen] = useState<PlacedFinding | null>(null);
  return (
    <OpenEvidence.Provider value={setOpen}>
      <McpjamChecks findings={entries} />
      {open ? (
        <EvidenceDrawer
          flow={flow}
          scope={SCOPE}
          resultsRunId="run_7"
          entry={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </OpenEvidence.Provider>
  );
}

async function openEvidence(title: string) {
  await userEvent.click(
    screen.getByRole("button", { name: `Show evidence for ${title}` }),
  );
  return within(await screen.findByRole("dialog"));
}

describe("EvidenceDrawer", () => {
  beforeEach(() => {
    api.getSubmissionFinding.mockReset();
    api.getSubmissionFinding.mockResolvedValue(stored());
  });

  it("offers no evidence where no submission is open", () => {
    render(<McpjamChecks findings={[listing]} />);
    expect(screen.queryByRole("button", { name: /Show evidence/ })).toBeNull();
  });

  it("opens from the result with what it read, the run, the rule, the next step and the stored observation", async () => {
    render(<Results entries={[listing]} />);
    const drawer = await openEvidence(listing.finding.title);

    expect(
      drawer.getByRole("heading", { name: listing.finding.title }),
    ).toBeVisible();
    expect(drawer.getByText("Blocker")).toBeVisible();
    expect(drawer.getByText("Established")).toBeVisible();
    expect(drawer.getByText(/From your answers/)).toBeVisible();
    expect(
      drawer.getByText("Nothing it read has changed since the run."),
    ).toBeVisible();
    // The stored result names the answers it read; the flow lists more.
    expect(
      await drawer.findByText("Your answers: Name, One-liner"),
    ).toBeVisible();
    expect(drawer.getByText("run_7")).toBeVisible();
    expect(drawer.getByText(/Nov 13, 2026, .* · Engine 1\.4\.0/)).toBeVisible();
    expect(
      drawer.getByRole("link", { name: /Listing fields/ }),
    ).toHaveAttribute(
      "href",
      claudePolicySource("submission", "Listing fields").url,
    );
    expect(drawer.getByText("Page as read on Nov 13, 2026.")).toBeVisible();
    expect(
      drawer.getByText("Add a one-liner of 200 characters or fewer."),
    ).toBeVisible();
    expect(drawer.getByText(/oneLiner/)).toBeVisible();
    expect(drawer.getByText("240")).toBeVisible();
    expect(api.getSubmissionFinding).toHaveBeenCalledWith(
      SCOPE,
      LISTING_FIELDS,
      expect.any(AbortSignal),
    );

    await userEvent.click(drawer.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the answer that went stale, what else it read, and a page MCPJam has not confirmed", async () => {
    api.getSubmissionFinding.mockResolvedValue(
      stored({
        checkId: redirects.finding.id,
        runId: "run_6",
        hasDetails: false,
        details: undefined,
        inputs: [
          { kind: "answer", key: "connection.serverUrl", fingerprint: "f3" },
          { kind: "catalog", key: "tools", fingerprint: "f4" },
        ],
      }),
    );
    render(<Results entries={[redirects]} />);
    const drawer = await openEvidence("Redirects stay on https");

    expect(drawer.getByText("Stale")).toBeVisible();
    // The note the results under each field show, naming what changed.
    expect(
      drawer.getByText(
        "Server URL changed after this run. Run checks again to update it.",
      ),
    ).toBeVisible();
    expect(
      await drawer.findByText("No observation was stored with this result."),
    ).toBeVisible();
    expect(drawer.getByText("Your answers: Server URL")).toBeVisible();
    expect(
      drawer.getByText("The tools your server listed, Your server"),
    ).toBeVisible();
    expect(
      drawer.getByText(
        "Stored by a different run from the one this page shows.",
      ),
    ).toBeVisible();
    expect(
      drawer.getByText("MCPJam has not confirmed this page's text."),
    ).toBeVisible();
    // A passing check has no next step.
    expect(drawer.queryByText("Next step")).toBeNull();
  });

  it("keeps the rest of the evidence when the stored observation does not load", async () => {
    api.getSubmissionFinding.mockRejectedValue(new Error("Request timed out."));
    render(<Results entries={[listing]} />);
    const drawer = await openEvidence(listing.finding.title);

    expect(await drawer.findByRole("alert")).toHaveTextContent(
      "The stored observation did not load. Request timed out. Close this panel and open it again.",
    );
    // Without the stored inputs, the flow's list of what the check reads.
    expect(
      drawer.getByText(/^Your answers: Name, Slug, One-liner/),
    ).toBeVisible();
    expect(
      drawer.getByText("Add a one-liner of 200 characters or fewer."),
    ).toBeVisible();
  });

  it("says when only the start of the observation was kept", async () => {
    api.getSubmissionFinding.mockResolvedValue(
      stored({ detailsTruncated: true }),
    );
    render(<Results entries={[listing]} />);
    const drawer = await openEvidence(listing.finding.title);
    expect(
      await drawer.findByText(
        "Only the first 8 KB of the observation were kept.",
      ),
    ).toBeVisible();
  });
});
