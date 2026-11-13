/**
 * A refused write on the page: when someone changed a field this tab was
 * saving, the form shows the saved value and the notice names the field, who
 * changed it and to what, keeping the person's value until they apply it
 * again. A refusal that names none of their fields is applied again without
 * asking.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONNECTOR_FLOW,
  type DirectoryAnswer,
} from "@mcpjam/sdk/browser";
import { PlatformApiError } from "@mcpjam/sdk/platform";
import { useDirectorySubmission } from "@/hooks/use-directory-submission";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";
import { PortalFrame } from "../PortalFrame";

const api = vi.hoisted(() => ({
  getDirectoryFlow: vi.fn(),
  getDirectorySubmission: vi.fn(),
  updateDirectorySubmission: vi.fn(),
  startDirectorySubmissionRun: vi.fn(),
  getDirectorySubmissionHandoff: vi.fn(),
  exportDirectorySubmission: vi.fn(),
}));
vi.mock("@/lib/apis/directory-submissions-api", () => api);

const runner = vi.hoisted(() => ({
  state: { status: "idle" },
  run: vi.fn(),
  watch: vi.fn(),
}));
vi.mock("@/hooks/use-directory-readiness-run", () => ({
  useDirectoryReadinessRun: () => runner,
}));

const SCOPE = { projectId: "proj_1", submissionId: "sub_1" };
const NOV_12 = Date.UTC(2026, 10, 12, 12);
const people = {
  you: "user_you",
  nameOf: (id: string) => (id === "user_pm" ? "Sample Person" : undefined),
};

function viewAt(revision: number, access?: DirectoryAnswer): SubmissionView {
  return {
    id: "sub_1",
    projectId: "proj_1",
    serverId: "srv_1",
    directory: "claude",
    flowId: "claude-connector",
    flowVersion: CLAUDE_CONNECTOR_FLOW.version,
    // As the API reads it: the portal's default until someone answers.
    answers: [
      access ?? {
        key: "useCases.access",
        value: "read-only",
        origin: "default",
      },
    ],
    revision,
    createdBy: "user_you",
    createdAt: 1,
    updatedAt: revision,
    fieldIssues: [],
    steps: [],
    resultsRunId: null,
    submissionUrl: CLAUDE_CONNECTOR_FLOW.submissionUrl,
  };
}

/** An agent wrote "Write only" through the API at revision 5. */
const theirs: DirectoryAnswer = {
  key: "useCases.access",
  value: "write-only",
  origin: "set",
  setBy: "user_pm",
  setByLabel: "Codex",
  setVia: "api",
  setAt: NOV_12,
  revision: 5,
};

function conflict(keys: string[], current: SubmissionView) {
  return new PlatformApiError(
    "This submission changed since you read it.",
    "CONFLICT",
    {
      status: 409,
      details: {
        currentRevision: current.revision,
        conflictingKeys: keys,
        current,
      },
    },
  );
}

function Frame() {
  const session = useDirectorySubmission({
    projectId: "proj_1",
    submissionId: "sub_1",
    server: { name: "Sample server" },
  });
  if (!session.flow || !session.view) return null;
  return (
    <PortalFrame
      flow={session.flow}
      view={session.view}
      session={session}
      people={people}
      onClose={() => undefined}
    />
  );
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Opens Use cases and answers Read and write. */
async function chooseReadAndWrite() {
  render(<Frame />);
  await settle();
  const rail = screen.getByRole("navigation", {
    name: "Claude submission steps",
  });
  fireEvent.click(within(rail).getByRole("button", { name: /Use cases/ }));
  fireEvent.click(screen.getByRole("radio", { name: /Read and write/ }));
  await settle(800);
}

describe("a refused write", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(api)) mock.mockReset();
    api.getDirectoryFlow.mockResolvedValue(CLAUDE_CONNECTOR_FLOW);
    api.getDirectorySubmission.mockResolvedValue(viewAt(3));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the field, who changed it and both values, then applies mine again", async () => {
    api.updateDirectorySubmission
      .mockRejectedValueOnce(conflict(["useCases.access"], viewAt(5, theirs)))
      .mockResolvedValueOnce(
        viewAt(6, {
          ...theirs,
          value: "read-write",
          setBy: "user_you",
          setByLabel: undefined,
          setVia: "web",
          revision: 6,
        }),
      );
    await chooseReadAndWrite();

    const notice = within(screen.getByRole("alert"));
    expect(
      notice.getByText(
        /^Read\/write capabilities changed while you were editing, so your change was not saved\. Apply yours again, or keep the saved value\.$/,
      ),
    ).toBeVisible();
    expect(notice.getByText("Saved: Write only")).toBeVisible();
    expect(
      notice.getByText(
        "Changed by Codex (signed in as Sample Person) via the API on Nov 12, 2026",
      ),
    ).toBeVisible();
    expect(notice.getByText("Yours: Read and write")).toBeVisible();
    // The form shows the saved value, marked with who set it.
    expect(screen.getByRole("radio", { name: /Write only/ })).toBeChecked();
    expect(
      screen.getByText(
        "Set by Codex (signed in as Sample Person) via the API on Nov 12, 2026",
      ),
    ).toBeVisible();

    fireEvent.click(
      notice.getByRole("button", { name: "Apply my changes again" }),
    );
    await settle(800);
    expect(api.updateDirectorySubmission).toHaveBeenLastCalledWith(SCOPE, {
      expectedRevision: 5,
      answers: { "useCases.access": "read-write" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("radio", { name: /Read and write/ })).toBeChecked();
  });

  it("keeps the saved value when the person chooses it", async () => {
    api.updateDirectorySubmission.mockRejectedValueOnce(
      conflict(["useCases.access"], viewAt(5, theirs)),
    );
    await chooseReadAndWrite();
    fireEvent.click(
      screen.getByRole("button", { name: "Keep the saved values" }),
    );
    await settle(800);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("radio", { name: /Write only/ })).toBeChecked();
    expect(api.updateDirectorySubmission).toHaveBeenCalledTimes(1);
  });

  it("applies the change again by itself when none of my fields clash", async () => {
    api.updateDirectorySubmission
      .mockRejectedValueOnce(conflict([], viewAt(5)))
      .mockResolvedValueOnce(viewAt(6));
    await chooseReadAndWrite();
    expect(screen.queryByRole("alert")).toBeNull();
    await settle(800);
    expect(api.updateDirectorySubmission).toHaveBeenLastCalledWith(SCOPE, {
      expectedRevision: 5,
      answers: { "useCases.access": "read-write" },
    });
  });
});
