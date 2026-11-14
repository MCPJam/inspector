/**
 * Status events and receipts. "Mark as submitted" records the confirmation
 * reference and the management link; each later status says how the person
 * knows; "Changes requested" imports the directory's words, as written, as a
 * record of their own. A refused write keeps the form, and a retry of the
 * same form is sent under the same key.
 */
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformApiError } from "@mcpjam/sdk/platform";
import { useSubmissionEvents } from "@/hooks/use-submission-events";
import type {
  SubmissionEvent,
  SubmissionEventBody,
} from "@/lib/apis/directory-submissions-api";
import type { People } from "../AnswerOrigin";
import { RecordStatusDialog } from "../RecordStatusDialog";
import { StatusPanel } from "../SubmissionStatus";
import { flow, recordedEvent, SCOPE } from "./readiness-fixtures";

const api = vi.hoisted(() => ({
  listSubmissionEvents: vi.fn(),
  recordSubmissionEvent: vi.fn(),
}));
vi.mock("@/lib/apis/directory-submissions-api", () => api);

/** The page's names: user_1 is Sample Person; the signed-in person is someone else. */
const PEOPLE: People = {
  you: "user_9",
  nameOf: (id) => (id === "user_1" ? "Sample Person" : undefined),
};

/** The server: what was recorded, newest first. */
let stored: SubmissionEvent[] = [];

function serve() {
  api.listSubmissionEvents.mockImplementation(
    async (_scope: unknown, kind: SubmissionEvent["kind"]) =>
      stored.filter((event) => event.kind === kind),
  );
  api.recordSubmissionEvent.mockImplementation(
    async (_scope: unknown, body: SubmissionEventBody) => {
      const {
        idempotencyKey: _key,
        finding,
        snapshot: _snapshot,
        ...rest
      } = body;
      const event = recordedEvent({
        ...rest,
        id: `evt_${stored.length + 1}`,
        createdAt: Date.UTC(2026, 10, 2, 12) + stored.length,
        ...(finding
          ? { finding: { ...finding, directory: "claude" as const } }
          : {}),
      });
      stored = [event, ...stored];
      return event;
    },
  );
}

/** The review page's wiring of the panel, its button and the form. */
function Review() {
  const events = useSubmissionEvents(SCOPE);
  const [recording, setRecording] = useState<"first" | "next" | null>(null);
  return (
    <>
      <StatusPanel
        flowId={flow.id}
        directory="Claude"
        people={PEOPLE}
        events={events}
        onRecord={() => setRecording("next")}
      />
      {events.loaded && events.status.length === 0 ? (
        <button type="button" onClick={() => setRecording("first")}>
          Mark as submitted
        </button>
      ) : null}
      {recording ? (
        <RecordStatusDialog
          directory="Claude"
          first={recording === "first"}
          onRecord={events.record}
          onClose={() => setRecording(null)}
        />
      ) : null}
    </>
  );
}

async function markAsSubmitted() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Mark as submitted" }),
  );
  return within(await screen.findByRole("dialog"));
}

const submitted = recordedEvent({
  id: "evt_0",
  kind: "status",
  state: "submitted",
  reference: "SUB-2048",
});

describe("submission status", () => {
  beforeEach(() => {
    stored = [];
    api.listSubmissionEvents.mockReset();
    api.recordSubmissionEvent.mockReset();
    serve();
  });

  it("marks the submission as submitted with its reference and management link", async () => {
    render(<Review />);
    const form = await markAsSubmitted();
    expect(
      form.getByRole("radio", { name: "I saw it in the Claude portal" }),
    ).toBeChecked();
    await userEvent.type(
      form.getByLabelText("Confirmation reference"),
      "SUB-2048",
    );
    await userEvent.type(
      form.getByLabelText("Management link"),
      "https://claude.ai/settings/submissions/sample",
    );
    await userEvent.click(
      form.getByRole("button", { name: "Mark as submitted" }),
    );

    expect(api.recordSubmissionEvent).toHaveBeenCalledWith(SCOPE, {
      kind: "status",
      state: "submitted",
      reportedOrObserved: "observed",
      reference: "SUB-2048",
      link: "https://claude.ai/settings/submissions/sample",
      idempotencyKey: expect.stringMatching(/^ui-status-.+-status$/),
    });
    // The portal's own page after submitting, then MCPJam's record of it.
    expect(
      await screen.findByRole("heading", {
        name: "Server submitted for review",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    const card = screen.getByRole("region", { name: "Submission status" });
    expect(within(card).getByText("Submitted")).toBeVisible();
    expect(within(card).getByText("Reference SUB-2048")).toBeVisible();
    expect(
      within(card).getByRole("link", { name: /Open on claude\.ai/ }),
    ).toHaveAttribute("href", "https://claude.ai/settings/submissions/sample");
    expect(
      within(card).getByText(
        "Claude decides on approval and publication. Record the status here when you hear back.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Status history")).toBeVisible();
    expect(
      screen.getByText("Recorded by Sample Person on Nov 2, 2026"),
    ).toBeVisible();
    expect(screen.getByText("Observed")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Mark as submitted" }),
    ).toBeNull();
  });

  it("records changes requested with the directory's words as their own record", async () => {
    stored = [submitted];
    render(<Review />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Record a new status" }),
    );
    const form = within(await screen.findByRole("dialog"));
    await userEvent.click(
      form.getByRole("radio", { name: "Changes requested" }),
    );
    await userEvent.click(
      form.getByRole("radio", { name: "Claude or someone else told me" }),
    );
    const record = form.getByRole("button", { name: "Record status" });
    // The directory's words are what this status is about.
    expect(record).toBeDisabled();
    const words = "Add a privacy policy URL.\nShorten the one-liner.";
    await userEvent.type(form.getByLabelText("What Claude said"), words);
    await userEvent.click(record);

    const calls = api.recordSubmissionEvent.mock.calls.map(([, body]) => body);
    expect(calls).toEqual([
      {
        kind: "directory-finding",
        reportedOrObserved: "reported",
        finding: { text: words, via: "email" },
        idempotencyKey: expect.stringMatching(/-finding$/),
      },
      expect.objectContaining({
        kind: "status",
        state: "changes-requested",
        reportedOrObserved: "reported",
        idempotencyKey: expect.stringMatching(/-status$/),
      }),
    ]);
    const card = await screen.findByRole("region", {
      name: "Submission status",
    });
    expect(within(card).getByText("Changes requested")).toBeVisible();
    expect(
      within(card).getByText(
        "Claude asked for changes. Fix them here, then send the update through the portal.",
      ),
    ).toBeVisible();
    // Only right after submitting does the portal show its receipt.
    expect(screen.queryByText("Server submitted for review")).toBeNull();
    expect(screen.getByText("What Claude said")).toBeVisible();
    expect(screen.getByRole("blockquote").textContent).toBe(words);
    expect(
      screen.getByText(/^By email · imported by Sample Person/),
    ).toBeVisible();
    expect(screen.getByText("Reported")).toBeVisible();
    expect(screen.getByText("Observed")).toBeVisible();
  });

  it("records a resubmission with its own receipt", async () => {
    stored = [
      recordedEvent({
        id: "evt_1",
        kind: "status",
        state: "changes-requested",
      }),
      submitted,
    ];
    render(<Review />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Record a new status" }),
    );
    const form = within(await screen.findByRole("dialog"));
    expect(form.queryByLabelText("Confirmation reference")).toBeNull();
    await userEvent.click(form.getByRole("radio", { name: "Submitted" }));
    await userEvent.type(
      form.getByLabelText("Confirmation reference"),
      "SUB-2049",
    );
    await userEvent.click(form.getByRole("button", { name: "Record status" }));
    expect(api.recordSubmissionEvent).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ state: "submitted", reference: "SUB-2049" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Server submitted for review",
      }),
    ).toBeVisible();
  });

  it("shows reported and observed, the directory's label as given, and who an agent acted for", async () => {
    stored = [
      recordedEvent({
        id: "evt_1",
        kind: "status",
        state: "in-review",
        reportedOrObserved: "reported",
        directoryLabel: "Under review",
        detail: "Read from the Submissions list",
        actorLabel: "Claude Code",
        createdAt: Date.UTC(2026, 10, 2, 12),
      }),
      submitted,
    ];
    render(<Review />);
    const card = await screen.findByRole("region", {
      name: "Submission status",
    });
    expect(within(card).getByText("In review")).toBeVisible();
    expect(within(card).getByText("Submitted Oct 29, 2026")).toBeVisible();
    expect(screen.getByText("Claude called it “Under review”")).toBeVisible();
    expect(screen.getByText("Read from the Submissions list")).toBeVisible();
    expect(
      screen.getByText(
        "Recorded by Claude Code (signed in as Sample Person) on Nov 2, 2026",
      ),
    ).toBeVisible();
    expect(screen.getByText("Reported")).toHaveAttribute(
      "title",
      "Passed on by the directory or someone else",
    );
    expect(screen.getByText("Observed")).toHaveAttribute(
      "title",
      "Seen first hand by whoever recorded it",
    );
  });

  it("keeps the form and says what to do when the server refuses the status", async () => {
    api.recordSubmissionEvent.mockRejectedValueOnce(
      new PlatformApiError(
        "The link must be an https address of at most 2048 characters. Copy it from the browser.",
        "VALIDATION_ERROR",
        { status: 400 },
      ),
    );
    render(<Review />);
    const form = await markAsSubmitted();
    const link = form.getByLabelText("Management link");
    await userEvent.type(link, "http://claude.ai/sample");
    await userEvent.click(
      form.getByRole("button", { name: "Mark as submitted" }),
    );

    expect(await form.findByRole("alert")).toHaveTextContent(
      "The status was not recorded. The link must be an https address of at most 2048 characters. Copy it from the browser. Try recording it again.",
    );
    expect(link).toHaveValue("http://claude.ai/sample");
    expect(screen.queryByText("Status history")).toBeNull();

    // A corrected form is a new write, under a new key.
    await userEvent.clear(link);
    await userEvent.type(link, "https://claude.ai/sample");
    await userEvent.click(
      form.getByRole("button", { name: "Mark as submitted" }),
    );
    expect(await screen.findByText("Status history")).toBeVisible();
    const [first, second] = api.recordSubmissionEvent.mock.calls.map(
      ([, body]) => body.idempotencyKey,
    );
    expect(second).not.toBe(first);
  });

  it("retries an unchanged form under the same key", async () => {
    api.recordSubmissionEvent.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    render(<Review />);
    const form = await markAsSubmitted();
    const submit = form.getByRole("button", { name: "Mark as submitted" });
    await userEvent.click(submit);
    expect(await form.findByRole("alert")).toHaveTextContent(
      "The status was not recorded. Failed to fetch. Try recording it again.",
    );
    await userEvent.click(submit);
    expect(await screen.findByText("Status history")).toBeVisible();
    const [first, second] = api.recordSubmissionEvent.mock.calls.map(
      ([, body]) => body.idempotencyKey,
    );
    expect(second).toBe(first);
  });

  it("says when the history did not load, and offers no submit until it has", async () => {
    api.listSubmissionEvents.mockRejectedValue(new Error("Request timed out."));
    render(<Review />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The status history did not load. Request timed out. Reload the page to try again.",
    );
    expect(
      screen.queryByRole("button", { name: "Mark as submitted" }),
    ).toBeNull();
  });
});
