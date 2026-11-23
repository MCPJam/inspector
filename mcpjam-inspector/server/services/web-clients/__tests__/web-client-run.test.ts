/**
 * What a web client's eval turn takes from its run: the owner to act as, the
 * accounts frozen at start and their rotation, and a refused freeze as the
 * run's reason to stop. Evidence: fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { actorForRun } from "../hosted-web-client-runtime";
import {
  freezeEvalRunWebAccounts,
  rotateRunAccounts,
  webClientRunOfEvalRun,
} from "../web-client-run";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("an eval run's web client context", () => {
  const run = {
    createdBy: "user-owner",
    webAccountsAtRun: [
      { webAccountId: "acct-claude", vendor: "claude", label: "Team", profileVersion: 2 },
      { webAccountId: "acct-gpt-1", vendor: "chatgpt", label: "Plus", profileVersion: 1 },
      { webAccountId: "acct-gpt-2", vendor: "chatgpt", label: "Free", profileVersion: 1 },
    ],
  };

  it("acts as the run's owner on the accounts it froze for its vendor", () => {
    expect(webClientRunOfEvalRun({ harness: "chatgpt-web", runId: "run-1", run })).toEqual({
      runId: "run-1",
      actor: { actorUserId: "user-owner" },
      webAccountIds: ["acct-gpt-1", "acct-gpt-2"],
    });
  });

  it("is nothing for another runtime or a quick run", () => {
    expect(webClientRunOfEvalRun({ harness: "claude-code", runId: "run-1", run })).toBeUndefined();
    expect(webClientRunOfEvalRun({ harness: "claude-web", runId: null, run })).toBeUndefined();
  });

  it("is unread for a row that doesn't name its owner and frozen accounts, never the default account", () => {
    for (const row of [{ createdBy: "user-owner" }, { webAccountsAtRun: run.webAccountsAtRun }, null, "row"]) {
      expect(webClientRunOfEvalRun({ harness: "claude-web", runId: "run-1", run: row })).toBeNull();
    }
    // Frozen with no account for its vendor: the run names none, and its turns use none.
    expect(
      webClientRunOfEvalRun({ harness: "claude-web", runId: "run-1", run: { createdBy: "user-owner", webAccountsAtRun: [] } }),
    ).toEqual({ runId: "run-1", actor: { actorUserId: "user-owner" }, webAccountIds: [] });
  });

  it("starts each iteration one account on, keeps an iteration's turns together, and keeps runs apart", () => {
    const webAccountIds = ["a", "b", "c"];
    const order = (runId: string, iterationId: string) => rotateRunAccounts({ runId, iterationId, webAccountIds });
    expect(order("rotation-run", "it-1")).toEqual(["a", "b", "c"]);
    expect(order("rotation-run", "it-2")).toEqual(["b", "c", "a"]);
    expect(order("rotation-run", "it-1")).toEqual(["a", "b", "c"]);
    expect(order("other-run", "it-1")).toEqual(["a", "b", "c"]);
    expect(order("rotation-run", "it-3")).toEqual(["c", "a", "b"]);
    expect(order("rotation-run", "it-4")).toEqual(["a", "b", "c"]);
    expect(rotateRunAccounts({ runId: "rotation-run", webAccountIds: ["only"] })).toEqual(["only"]);
  });
});

describe("freezing the run's web accounts", () => {
  const freeze = (mutation: () => Promise<unknown>, harness = "claude-web") => {
    const failRun = vi.fn(async () => undefined);
    const frozen = freezeEvalRunWebAccounts({ convexClient: { mutation }, runId: "run-1", harness, failRun });
    return { frozen, failRun };
  };

  it("records them for the run's vendor, and none for another runtime", async () => {
    const mutation = vi.fn(async () => []);
    await freeze(mutation, "chatgpt-web").frozen;
    expect(mutation).toHaveBeenCalledWith("webClientSuites:recordWebAccountsAtRun", {
      runId: "run-1",
      vendor: "chatgpt",
    });
    await freeze(mutation, "claude-code").frozen;
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("fails the run with the backend's refusal as a 400 in its own words", async () => {
    const { frozen, failRun } = freeze(async () => {
      throw new ConvexError({ code: "VALIDATION", message: "Web clients are off for this project." });
    });
    await expect(frozen).rejects.toMatchObject({
      status: 400,
      message: "Web clients are off for this project.",
      details: { reason: "WEB_ACCOUNTS_UNAVAILABLE" },
    });
    expect(failRun).toHaveBeenCalledWith("Web clients are off for this project.");
  });

  it("fails the run as a 503 when the backend couldn't answer, never as the caller's mistake", async () => {
    for (const lost of [new Error("fetch failed"), new Error("[Request ID: 1] Server Error")]) {
      const { frozen, failRun } = freeze(async () => {
        throw lost;
      });
      await expect(frozen).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining("Run it again."),
        details: { reason: "WEB_ACCOUNTS_UNAVAILABLE" },
      });
      expect(failRun).toHaveBeenCalledWith(expect.stringContaining("Run it again."));
    }
  });
});

describe("the person a run's bearer names", () => {
  it("asks the backend about a delegated run session and refuses guests", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
    const whoIs = vi.fn(async () => ({ _id: "user-owner", isAnonymous: false }));
    expect(await actorForRun("Bearer delegated-run-token", whoIs)).toEqual({ actorUserId: "user-owner" });
    expect(whoIs).toHaveBeenCalledWith("delegated-run-token");
    expect(await actorForRun("Bearer guest-token", async () => ({ _id: "guest-1", isAnonymous: true }))).toBeUndefined();
    expect(await actorForRun("Bearer unknown-token", async () => null)).toBeUndefined();
  });
});
