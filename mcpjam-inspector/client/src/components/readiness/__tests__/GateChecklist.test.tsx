/**
 * The checklist that chooses which checks fail a run (V8). It names the gate
 * the verdict used, saves a change at the revision it was read at, and on a
 * refusal because someone changed the gate, shows the saved gate and holds
 * this tab's change until the person reapplies it.
 */
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformApiError } from "@mcpjam/sdk/platform";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";
import { GateChecklist } from "../GateChecklist";
import {
  flow,
  LISTING_FIELDS,
  LISTING_URLS,
  SCOPE,
  submissionView,
} from "./readiness-fixtures";

const api = vi.hoisted(() => ({ updateDirectorySubmission: vi.fn() }));
vi.mock("@/lib/apis/directory-submissions-api", () => api);

const FIELDS_TITLE = "Listing fields follow the portal's rules";
const URLS_TITLE = "Listing links answer";

function Gate({ initial }: { initial: SubmissionView }) {
  const [view, setView] = useState(initial);
  return (
    <GateChecklist
      flow={flow}
      view={view}
      directory="Claude"
      onSaved={setView}
    />
  );
}

function conflict(
  currentRevision: number,
  keys: string[],
  current?: SubmissionView,
) {
  return new PlatformApiError(
    "This submission changed since you read it.",
    "CONFLICT",
    {
      status: 409,
      details: { currentRevision, conflictingKeys: keys, current },
    },
  );
}

const box = (title: string) =>
  screen.getByRole("checkbox", { name: new RegExp(`^${title}`) });

async function showChecks() {
  await userEvent.click(
    screen.getByRole("button", { name: "Choose the checks" }),
  );
}

describe("GateChecklist", () => {
  beforeEach(() => api.updateDirectorySubmission.mockReset());

  it("names the gate and judges the last run by it", async () => {
    render(<Gate initial={submissionView()} />);
    expect(
      screen.getByText("Not ready. 1 check in the gate failed."),
    ).toBeVisible();
    expect(screen.getByText("Gate: Claude's blocking checks.")).toBeVisible();

    await showChecks();
    expect(box(FIELDS_TITLE)).toBeChecked();
    expect(box(URLS_TITLE)).not.toBeChecked();
    expect(box("The server URL uses https")).toBeChecked();
    const fields = box(FIELDS_TITLE).closest("label");
    if (!fields) throw new Error("No row for the listing check");
    expect(within(fields).getByText("Fails the run")).toBeVisible();
    expect(within(fields).getByText(LISTING_FIELDS)).toBeVisible();
    expect(screen.getByText("Listing")).toBeVisible();
    expect(screen.getByText("Connection")).toBeVisible();
  });

  it("V8: a Listing check moved to warn only is saved at the read revision, still shows, and the gate is named", async () => {
    const saved = submissionView(undefined, {
      revision: 4,
      checkGate: { warnOnly: [LISTING_FIELDS] },
    });
    api.updateDirectorySubmission.mockResolvedValue(saved);
    render(<Gate initial={submissionView()} />);
    await showChecks();

    await userEvent.click(box(FIELDS_TITLE));
    expect(
      screen.getByText(/Fails a run by default\. Set to warn only\./),
    ).toBeVisible();
    expect(screen.getByText("Not saved yet.")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Save the gate" }),
    );

    expect(api.updateDirectorySubmission).toHaveBeenCalledWith(SCOPE, {
      expectedRevision: 3,
      checkGate: { failOn: [], warnOnly: [LISTING_FIELDS] },
    });
    expect(
      await screen.findByText(`Warns only on: ${FIELDS_TITLE}.`),
    ).toBeVisible();
    expect(screen.getByText(/^Ready under this gate\./)).toBeVisible();
    // The result still shows, marked as one that no longer fails the run.
    const fields = box(FIELDS_TITLE).closest("label");
    if (!fields) throw new Error("No row for the listing check");
    expect(within(fields).getByText("Failed, warns only")).toBeVisible();
    expect(screen.queryByText("Not saved yet.")).toBeNull();
  });

  it("adds a check that only warns by default to fail on", async () => {
    api.updateDirectorySubmission.mockResolvedValue(
      submissionView(undefined, {
        revision: 4,
        checkGate: { failOn: [LISTING_URLS] },
      }),
    );
    render(<Gate initial={submissionView()} />);
    await showChecks();
    await userEvent.click(box(URLS_TITLE));
    expect(
      screen.getByText(/Warns only by default\. Set to fail a run\./),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Save the gate" }),
    );
    expect(api.updateDirectorySubmission).toHaveBeenCalledWith(SCOPE, {
      expectedRevision: 3,
      checkGate: { failOn: [LISTING_URLS], warnOnly: [] },
    });
    expect(
      await screen.findByText(`Also fails on: ${URLS_TITLE}.`),
    ).toBeVisible();
  });

  it("on a 409 over the gate, shows the saved gate and reapplies this tab's change on top of it", async () => {
    const theirs = submissionView(undefined, {
      revision: 5,
      checkGate: { failOn: [LISTING_URLS] },
    });
    api.updateDirectorySubmission
      .mockRejectedValueOnce(conflict(5, ["checkGate"], theirs))
      .mockResolvedValueOnce(
        submissionView(undefined, {
          revision: 6,
          checkGate: { failOn: [LISTING_URLS], warnOnly: [LISTING_FIELDS] },
        }),
      );
    render(<Gate initial={submissionView()} />);
    await showChecks();
    await userEvent.click(box(FIELDS_TITLE));
    await userEvent.click(
      screen.getByRole("button", { name: "Save the gate" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The gate changed while you were editing, so your change was not saved. Apply yours again, or keep the saved gate.",
    );
    // Their gate, not this tab's.
    expect(screen.getByText(`Also fails on: ${URLS_TITLE}.`)).toBeVisible();
    expect(box(FIELDS_TITLE)).toBeChecked();

    await userEvent.click(
      screen.getByRole("button", { name: "Apply my changes again" }),
    );
    expect(api.updateDirectorySubmission).toHaveBeenLastCalledWith(SCOPE, {
      expectedRevision: 5,
      checkGate: { failOn: [LISTING_URLS], warnOnly: [LISTING_FIELDS] },
    });
    expect(
      await screen.findByText(`Warns only on: ${FIELDS_TITLE}.`),
    ).toBeVisible();
    expect(screen.getByText(`Also fails on: ${URLS_TITLE}.`)).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the saved gate when the person chooses it after a 409", async () => {
    api.updateDirectorySubmission.mockRejectedValueOnce(
      conflict(5, ["checkGate"], submissionView(undefined, { revision: 5 })),
    );
    render(<Gate initial={submissionView()} />);
    await showChecks();
    await userEvent.click(box(FIELDS_TITLE));
    await userEvent.click(
      screen.getByRole("button", { name: "Save the gate" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Keep the saved gate" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.updateDirectorySubmission).toHaveBeenCalledTimes(1);
  });

  it("saves again on the current revision when only other fields changed", async () => {
    api.updateDirectorySubmission
      .mockRejectedValueOnce(conflict(8, ["listing.name"]))
      .mockResolvedValueOnce(
        submissionView(undefined, {
          revision: 9,
          checkGate: { warnOnly: [LISTING_FIELDS] },
        }),
      );
    render(<Gate initial={submissionView()} />);
    await showChecks();
    await userEvent.click(box(FIELDS_TITLE));
    await userEvent.click(
      screen.getByRole("button", { name: "Save the gate" }),
    );
    expect(
      await screen.findByText(`Warns only on: ${FIELDS_TITLE}.`),
    ).toBeVisible();
    expect(api.updateDirectorySubmission).toHaveBeenLastCalledWith(SCOPE, {
      expectedRevision: 8,
      checkGate: { failOn: [], warnOnly: [LISTING_FIELDS] },
    });
  });

  it("keeps the change and says what to do when a save is refused", async () => {
    api.updateDirectorySubmission.mockRejectedValueOnce(
      new PlatformApiError(
        "The gate lists more than 200 checks.",
        "VALIDATION_ERROR",
        {
          status: 400,
        },
      ),
    );
    render(<Gate initial={submissionView()} />);
    await showChecks();
    await userEvent.click(box(FIELDS_TITLE));
    await userEvent.click(
      screen.getByRole("button", { name: "Save the gate" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The gate was not saved. The gate lists more than 200 checks. Try saving it again.",
    );
    expect(box(FIELDS_TITLE)).not.toBeChecked();
    expect(screen.getByText("Not saved yet.")).toBeVisible();
  });

  it("restores the directory's default by saving no gate", async () => {
    api.updateDirectorySubmission.mockResolvedValue(
      submissionView(undefined, { revision: 4 }),
    );
    render(
      <Gate
        initial={submissionView(undefined, {
          checkGate: { failOn: [LISTING_URLS] },
        })}
      />,
    );
    await showChecks();
    await userEvent.click(
      screen.getByRole("button", { name: "Use Claude's default" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save the gate" }),
    );
    expect(api.updateDirectorySubmission).toHaveBeenCalledWith(SCOPE, {
      expectedRevision: 3,
      checkGate: null,
    });
  });

  it("before a run, asks for one and lists no checks", async () => {
    render(<Gate initial={submissionView([])} />);
    expect(
      screen.getByText(
        "Not checked yet. Run checks to see whether this rehearsal passes its gate.",
      ),
    ).toBeVisible();
    await showChecks();
    expect(screen.getByText("Run checks to list them here.")).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
