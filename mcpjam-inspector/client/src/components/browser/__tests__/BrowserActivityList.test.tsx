/**
 * The rail's record of what drove the browser.
 *
 * What is asserted here is mostly about HONESTY rather than layout: the three
 * outcomes stay three different things, a gap in the history is shown rather
 * than closed over, and a typed password is absent because the row it renders
 * never carried one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const listSessions = vi.fn();
const readTrace = vi.fn();

vi.mock("@/lib/local-browser/client", () => ({
  listLocalBrowserSessions: (...args: unknown[]) => listSessions(...args),
  readLocalBrowserTrace: (...args: unknown[]) => readTrace(...args),
}));

const { BrowserActivityList, actorLabel, describe: describeRow } = await import(
  "../BrowserActivityList"
);
import type { LocalBrowserTraceRow } from "@/lib/local-browser/client";

/** The pane's own poll interval, so a test waits exactly one tick. */
const POLL_MS = 2_000;

function row(over: Partial<LocalBrowserTraceRow> = {}): LocalBrowserTraceRow {
  return {
    kind: "command",
    seq: 1,
    commandId: "c1",
    ts: 1,
    durationMs: 42,
    source: "agent",
    actor: { kind: "agent", id: "cli:mcpjam-cli", label: "user-1" },
    command: { kind: "reload" },
    outcome: "executed",
    ok: true,
    ...over,
  };
}

beforeEach(() => {
  listSessions.mockReset();
  readTrace.mockReset();
  listSessions.mockResolvedValue({
    sessions: [{ sessionId: "bs_1", closedAt: undefined }],
  });
  readTrace.mockResolvedValue({ entries: [], headSeq: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

function mount(props: Partial<Parameters<typeof BrowserActivityList>[0]> = {}) {
  return render(
    <BrowserActivityList
      projectId="proj-1"
      consentToken="cap"
      active
      {...props}
    />,
  );
}

describe("BrowserActivityList", () => {
  it("says nothing has driven the browser rather than showing an empty box", async () => {
    mount();
    expect(
      await screen.findByText(/Nothing has driven this browser yet/i),
    ).toBeTruthy();
  });

  it("polls nothing while the tab is hidden", async () => {
    // A pane nobody is looking at must not keep the browser awake or spend a
    // request every two seconds saying so.
    mount({ active: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listSessions).not.toHaveBeenCalled();
    expect(readTrace).not.toHaveBeenCalled();
  });

  it("finds the project's open session by itself", async () => {
    // The rail knows a project; the session was opened by an agent elsewhere.
    listSessions.mockResolvedValue({
      sessions: [
        { sessionId: "bs_closed", closedAt: 5 },
        { sessionId: "bs_open" },
      ],
    });
    mount();
    await waitFor(() =>
      expect(readTrace).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "bs_open" }),
        "cap",
      ),
    );
  });

  it("reads forward from the last seq it saw", async () => {
    readTrace.mockResolvedValueOnce({ entries: [row({ seq: 7 })], headSeq: 7 });
    readTrace.mockResolvedValue({ entries: [], headSeq: 7 });
    mount();
    await waitFor(() => expect(screen.getByText(/reload/)).toBeTruthy());
    // The next tick asks only for what it has not seen — one small request per
    // poll, rather than the session's whole history every two seconds.
    await waitFor(
      () =>
        expect(readTrace).toHaveBeenLastCalledWith(
          expect.objectContaining({ afterSeq: 7 }),
          "cap",
        ),
      { timeout: 5_000 },
    );
  });

  it("keeps the FIRST page of rows it fetched", async () => {
    // The regression this pins: learning which session to read is not a change
    // OF session, and treating it as one wiped the page the same poll had just
    // appended while leaving the cursor past it — so a session's opening rows
    // vanished and were never fetched again.
    readTrace.mockResolvedValueOnce({
      entries: [row({ seq: 1, command: { kind: "navigate", url: "https://x.test" } })],
      headSeq: 1,
    });
    readTrace.mockResolvedValue({ entries: [], headSeq: 1 });
    mount();
    expect(await screen.findByText(/navigate https:\/\/x.test/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/Nothing has driven/)).toBeNull();
  });

  it("drops the session AND the rows when the project changes", async () => {
    // `sessionId` is rediscovered only when null, so without a reset the pane
    // keeps polling the previous project's session and keeps showing its
    // history — one project's browsing under another project's name, which is
    // the one mistake a per-project profile exists to prevent.
    listSessions.mockResolvedValue({ sessions: [{ sessionId: "bs_a" }] });
    readTrace.mockResolvedValueOnce({
      entries: [row({ seq: 1, command: { kind: "navigate", url: "https://a.test" } })],
      headSeq: 1,
    });
    readTrace.mockResolvedValue({ entries: [], headSeq: 1 });
    const { rerender } = mount({ projectId: "proj-a" });
    expect(await screen.findByText(/navigate https:\/\/a.test/)).toBeTruthy();

    listSessions.mockResolvedValue({ sessions: [{ sessionId: "bs_b" }] });
    readTrace.mockResolvedValue({ entries: [], headSeq: 0 });
    rerender(
      <BrowserActivityList projectId="proj-b" consentToken="cap" active />,
    );
    // The old project's rows are gone…
    await waitFor(() =>
      expect(screen.queryByText(/navigate https:\/\/a.test/)).toBeNull(),
    );
    // …and the poll asks the NEW project's session, from the start.
    await waitFor(() =>
      expect(readTrace).toHaveBeenLastCalledWith(
        expect.objectContaining({
          projectId: "proj-b",
          sessionId: "bs_b",
          afterSeq: 0,
        }),
        "cap",
      ),
    );
  });

  it("clears 'history unavailable' once the lookup works again", async () => {
    // The warning was set on a failure and never on a success, so a project
    // with no open session wore "history unavailable" for as long as it had
    // none — long after looking had started working.
    vi.useFakeTimers();
    listSessions.mockRejectedValueOnce(new Error("offline"));
    listSessions.mockResolvedValue({ sessions: [] });
    mount();
    await vi.waitFor(() =>
      expect(screen.queryByText(/history unavailable/i)).toBeTruthy(),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.waitFor(() =>
      expect(screen.queryByText(/history unavailable/i)).toBeNull(),
    );
  });

  it("does not let a poll for the OLD project unlatch the new one", async () => {
    // The latch is what keeps two polls from reading one cursor and appending
    // the same rows twice. A poll left over from a project we have switched
    // away from used to clear it on its way out — releasing the latch the
    // current poll was holding, so the next tick started a second one beside
    // it and one click appeared in the list twice.
    vi.useFakeTimers();
    let releaseOld: (value: unknown) => void = () => {};
    listSessions.mockResolvedValue({ sessions: [{ sessionId: "bs_a" }] });
    readTrace.mockImplementationOnce(
      () => new Promise((resolve) => (releaseOld = resolve)),
    );
    const { rerender } = mount({ projectId: "proj-a" });
    await vi.waitFor(() => expect(readTrace).toHaveBeenCalledTimes(1));

    listSessions.mockResolvedValue({ sessions: [{ sessionId: "bs_b" }] });
    let releaseNew: (value: unknown) => void = () => {};
    readTrace.mockImplementationOnce(
      () => new Promise((resolve) => (releaseNew = resolve)),
    );
    rerender(
      <BrowserActivityList projectId="proj-b" consentToken="cap" active />,
    );
    await vi.waitFor(() => expect(readTrace).toHaveBeenCalledTimes(2));

    // The abandoned poll answers while the new one is still out…
    releaseOld({ entries: [], headSeq: 0 });
    // …and a tick arrives to find out whether it took the latch with it.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // No third poll may start: the second is still holding the latch.
    expect(readTrace).toHaveBeenCalledTimes(2);
    releaseNew({ entries: [], headSeq: 0 });
  });

  it("moves on when the session it was reading has CLOSED", async () => {
    // It resolves a session once and follows it, which is right until that
    // session ends — a closed session's trace still reads perfectly, so the
    // pane sat on a history that had simply stopped moving.
    vi.useFakeTimers();
    listSessions.mockResolvedValue({ sessions: [{ sessionId: "bs_a" }] });
    readTrace.mockResolvedValue({ entries: [], headSeq: 0 });
    mount();
    await vi.waitFor(() =>
      expect(readTrace).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "bs_a" }),
        "cap",
      ),
    );

    listSessions.mockResolvedValue({
      sessions: [{ sessionId: "bs_a", closedAt: 1 }, { sessionId: "bs_b" }],
    });
    // Quiet ticks, until the pane thinks to ask again.
    for (let tick = 0; tick <= 16; tick += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }
    await vi.waitFor(() =>
      expect(readTrace).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: "bs_b", afterSeq: 0 }),
        "cap",
      ),
    );
  });

  it("stays with an idle session while a newer one is also open", async () => {
    // A project can have a person's persistent session and several ephemeral
    // runs open at once. Switching to whichever is newest handed the pane to
    // the last run to start and wiped the history somebody was reading — for a
    // session that had never closed. Quiet is not the same as over.
    vi.useFakeTimers();
    listSessions.mockResolvedValue({ sessions: [{ sessionId: "bs_a" }] });
    readTrace.mockResolvedValue({ entries: [], headSeq: 0 });
    mount();
    await vi.waitFor(() =>
      expect(readTrace).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "bs_a" }),
        "cap",
      ),
    );

    // A run starts alongside it; `bs_a` is quiet but open.
    listSessions.mockResolvedValue({
      sessions: [{ sessionId: "bs_b" }, { sessionId: "bs_a" }],
    });
    for (let tick = 0; tick <= 20; tick += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }
    expect(readTrace).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "bs_a" }),
      "cap",
    );
  });

  it("keeps `refused` and `unknown` as different things", async () => {
    // A reader who cannot tell them apart cannot tell whether to retry:
    // `refused` means nothing ran; `unknown` means we cannot say.
    readTrace.mockResolvedValueOnce({
      entries: [
        row({ seq: 1, outcome: "refused", errorCode: "lease_held", ok: undefined }),
        row({
          seq: 2,
          outcome: "unknown",
          errorCode: "command_expired",
          ok: undefined,
        }),
      ],
      headSeq: 2,
    });
    mount();
    expect(await screen.findByText("lease_held")).toBeTruthy();
    expect(await screen.findByText("unknown")).toBeTruthy();
    // And the `unknown` row spells out what it means for a retry.
    const unknown = screen.getByTitle(/may or may not have run/i);
    expect(unknown).toBeTruthy();
  });

  it("shows a gap rather than closing over missing history", async () => {
    readTrace.mockResolvedValueOnce({
      entries: [
        {
          kind: "gap",
          seq: 3,
          ts: 1,
          fromSeq: 1,
          toSeq: 2,
          reason: "daemon_restart",
        },
      ],
      headSeq: 3,
    });
    mount();
    expect(await screen.findByText(/the browser restarted here/i)).toBeTruthy();
  });

  it("counts what an overflow dropped", async () => {
    readTrace.mockResolvedValueOnce({
      entries: [
        {
          kind: "gap",
          seq: 12,
          ts: 1,
          fromSeq: 3,
          toSeq: 12,
          reason: "ring_overflow",
        },
      ],
      headSeq: 12,
    });
    mount();
    expect(
      await screen.findByText(/10 earlier commands are no longer kept/i),
    ).toBeTruthy();
  });

  it("surfaces a history warning instead of letting the hole go unexplained", async () => {
    readTrace.mockResolvedValue({
      entries: [],
      headSeq: 0,
      historyWarning: "the newest rows could not be written",
    });
    mount();
    expect(await screen.findByText(/history incomplete/i)).toBeTruthy();
  });
});

describe("describe — what a row says it did", () => {
  it("shows the typed length, never the typed text", () => {
    // There is nothing to redact in the component: the row it renders was
    // already written as a shape rather than a secret.
    const line = describeRow(
      row({
        command: {
          kind: "act",
          verb: "type",
          target: { selector: "#password" },
          redactedValue: { redacted: true, chars: 11 },
        },
      }),
    );
    expect(line).toContain("11 chars (hidden)");
    expect(line).toContain("#password");
  });

  it("keeps a value that was not a secret", () => {
    expect(
      describeRow(
        row({ command: { kind: "act", verb: "press", value: "Enter" } }),
      ),
    ).toContain("Enter");
  });

  it("names each command kind readably", () => {
    expect(
      describeRow(row({ command: { kind: "navigate", url: "https://x.test" } })),
    ).toBe("navigate https://x.test");
    expect(describeRow(row({ command: { kind: "observe", mode: "a11y" } }))).toBe(
      "observe a11y",
    );
    expect(
      describeRow(row({ command: { kind: "note", value: "signing in" } })),
    ).toContain("signing in");
    expect(
      describeRow(
        row({
          command: { kind: "act", verb: "click", target: { a11yRef: "e7" } },
        }),
      ),
    ).toBe("click e7");
    expect(
      describeRow(
        row({
          command: { kind: "act", verb: "click", target: { coordinates: [4, 9] } },
        }),
      ),
    ).toBe("click (4, 9)");
  });
});

describe("actorLabel", () => {
  it("tells the person, the model and a named agent apart", () => {
    expect(actorLabel(row({ actor: { kind: "human", id: "pane:u" } }))).toBe(
      "you",
    );
    expect(actorLabel(row({ actor: { kind: "model", id: "model:x" } }))).toBe(
      "model",
    );
    // Two agents on one session must not read as one.
    expect(actorLabel(row({ actor: { kind: "agent", id: "mcp:claude" } }))).toBe(
      "mcp:claude",
    );
  });
});
