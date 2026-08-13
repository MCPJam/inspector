import { describe, expect, it } from "vitest";
import {
  planChatboxSandbox,
  readComputerSandboxMode,
} from "../chatbox-runtime-config.js";

/**
 * The `computerSandbox` marker has THREE states, and the third one — absence —
 * is what makes this feature deployable without a flag day. These tests pin
 * that absence and malformation both mean "the backend told us nothing usable",
 * i.e. keep today's personal-computer behaviour.
 */
describe("readComputerSandboxMode", () => {
  it("reads the two stated modes", () => {
    expect(
      readComputerSandboxMode({ computerSandbox: { mode: "ephemeral" } })
    ).toBe("ephemeral");
    expect(
      readComputerSandboxMode({
        computerSandbox: { mode: "unavailable", reason: "no ready build" },
      })
    ).toBe("unavailable");
  });

  it("returns null for an OLD BACKEND — never 'unavailable'", () => {
    // Absent must not be read as "no image": that would silently strip bash
    // from every chatbox the moment a deploy skewed.
    expect(readComputerSandboxMode({ computer: { kind: "personal" } })).toBe(
      null
    );
    expect(readComputerSandboxMode(undefined)).toBe(null);
    expect(readComputerSandboxMode(null)).toBe(null);
  });

  it("returns null for a malformed marker — never 'ephemeral'", () => {
    // Reading garbage as `ephemeral` would provision a paid box against a
    // policy nobody stated.
    expect(readComputerSandboxMode({ computerSandbox: { mode: "yes" } })).toBe(
      null
    );
    expect(readComputerSandboxMode({ computerSandbox: "ephemeral" })).toBe(
      null
    );
    expect(readComputerSandboxMode({ computerSandbox: {} })).toBe(null);
  });
});

/**
 * The plan is the ONLY thing standing between a chatbox turn and a call that
 * spends money, so the matrix is pinned exhaustively. The load-bearing row is
 * `not_a_data_plane`: provisioning is bearer-authed and succeeds from any
 * inspector, but a server without the E2B credentials can never exec in the
 * box — the old code stranded a billable sandbox whose every command failed.
 */
describe("planChatboxSandbox", () => {
  const ephemeral = {
    mode: "ephemeral" as const,
    bashRequested: true,
    ephemeralCloudAvailable: true,
    hasChatSessionId: true,
  };

  it("provisions only when every requirement holds", () => {
    expect(planChatboxSandbox(ephemeral)).toEqual({ action: "provision" });
  });

  it("suppresses WITH a tester notice when this server is not a data plane", () => {
    expect(
      planChatboxSandbox({ ...ephemeral, ephemeralCloudAvailable: false })
    ).toEqual({
      action: "suppress",
      suppressReason: "not_a_data_plane",
      notice: "sandbox_unavailable",
    });
  });

  it("checks the data plane before the session id — the tester deserves the explanation either way", () => {
    expect(
      planChatboxSandbox({
        ...ephemeral,
        ephemeralCloudAvailable: false,
        hasChatSessionId: false,
      })
    ).toMatchObject({ suppressReason: "not_a_data_plane" });
  });

  it("suppresses silently (log-only) without a chatSessionId", () => {
    expect(
      planChatboxSandbox({ ...ephemeral, hasChatSessionId: false })
    ).toEqual({ action: "suppress", suppressReason: "no_chat_session_id" });
  });

  it("suppresses on an `unavailable` marker regardless of anything else", () => {
    expect(
      planChatboxSandbox({
        ...ephemeral,
        mode: "unavailable",
        ephemeralCloudAvailable: false,
        bashRequested: false,
      })
    ).toEqual({
      action: "suppress",
      suppressReason: "sandbox_mode_unavailable",
    });
  });

  it("does nothing for a legacy (marker-absent) config — even on a non-data-plane server", () => {
    // Absent marker = personal-computer behavior; the preflight must not
    // start stripping bash from legacy chatboxes on deploy skew.
    expect(
      planChatboxSandbox({
        ...ephemeral,
        mode: null,
        ephemeralCloudAvailable: false,
      })
    ).toEqual({ action: "none" });
  });

  it("does nothing when the turn never asked for bash — no notice noise", () => {
    expect(
      planChatboxSandbox({
        ...ephemeral,
        bashRequested: false,
        ephemeralCloudAvailable: false,
      })
    ).toEqual({ action: "none" });
  });
});
