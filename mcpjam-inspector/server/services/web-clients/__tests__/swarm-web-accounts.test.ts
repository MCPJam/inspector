/**
 * A web client swarm's accounts: one session per account at a time, the rest
 * queued; a lost account leaves the pool, and with none left a waiting
 * session stops with the reason. Evidence: fixture.
 */
import { describe, expect, it, vi } from "vitest";
import { createSwarmWebAccounts, createWebAccountPool } from "../swarm-web-accounts";
import { WebAccountUnavailableError } from "../web-client-run";

const NONE = "No account is signed in.";
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a web account pool", () => {
  it("hands each account to one session at a time and the next waiting one takes it", async () => {
    const pool = createWebAccountPool(["a"], NONE);
    const first = await pool.acquire();
    let second: string | undefined;
    const waiting = pool.acquire().then((lease) => (second = lease.webAccountId));
    await settled();
    expect(second).toBeUndefined();
    first.release();
    await waiting;
    expect(second).toBe("a");
  });

  it("runs as many sessions at once as it has accounts", async () => {
    const pool = createWebAccountPool(["a", "b"], NONE);
    const leases = await Promise.all([pool.acquire(), pool.acquire()]);
    expect(leases.map((lease) => lease.webAccountId)).toEqual(["a", "b"]);
  });

  it("drops a lost account and gives waiting sessions the others", async () => {
    const pool = createWebAccountPool(["a", "b"], NONE);
    const a = await pool.acquire();
    const b = await pool.acquire();
    const waiting = pool.acquire();
    a.lose("Account a was signed out.");
    b.release();
    expect((await waiting).webAccountId).toBe("b");
  });

  it("stops waiting sessions with the reason once no account is left", async () => {
    const pool = createWebAccountPool(["a"], NONE);
    const a = await pool.acquire();
    const waiting = pool.acquire();
    a.lose("Account a was signed out.");
    await expect(waiting).rejects.toThrow(new WebAccountUnavailableError("Account a was signed out."));
    await expect(pool.acquire()).rejects.toThrow("Account a was signed out.");
    a.release();
    await expect(pool.acquire()).rejects.toThrow("Account a was signed out.");
  });

  it("refuses at once without a usable account, and lets a stopped session stop waiting", async () => {
    await expect(createWebAccountPool([], NONE).acquire()).rejects.toThrow(NONE);
    const pool = createWebAccountPool(["a"], NONE);
    const held = await pool.acquire();
    const stop = new AbortController();
    const waiting = pool.acquire(stop.signal);
    stop.abort(new Error("run stopped"));
    await expect(waiting).rejects.toThrow("run stopped");
    held.release();
    expect((await pool.acquire()).webAccountId).toBe("a");
  });
});

describe("a swarm's web accounts", () => {
  const rows = [
    { webAccountId: "old", vendor: "chatgpt", status: "ready", hasProfile: true, isDefault: false },
    { webAccountId: "signed-out", vendor: "chatgpt", status: "needs_sign_in", hasProfile: true },
    { webAccountId: "no-profile", vendor: "chatgpt", status: "ready", hasProfile: false },
    { webAccountId: "claude", vendor: "claude", status: "ready", hasProfile: true },
    { webAccountId: "default", vendor: "chatgpt", status: "ready", hasProfile: true, isDefault: true },
  ];

  function swarm(read = vi.fn(async () => rows)) {
    return {
      read,
      accounts: createSwarmWebAccounts({
        projectId: "project-1",
        runId: "swarm-run-1",
        getBearer: async () => "delegated-token",
        service: { read, apply: vi.fn() },
        actorOf: async () => ({ actorUserId: "owner-1" }),
      }),
    };
  }

  it("freezes the vendor's signed-in accounts once, the default first, for the run's owner", async () => {
    const { read, accounts } = swarm();
    const first = await accounts.acquire("chatgpt-web");
    const second = await accounts.acquire("chatgpt-web");
    expect([first?.lease.webAccountId, second?.lease.webAccountId]).toEqual(["default", "old"]);
    expect(first?.run).toMatchObject({
      runId: "swarm-run-1",
      actor: { actorUserId: "owner-1" },
      webAccountIds: ["default"],
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ action: "listWebAccounts", projectId: "project-1", actorUserId: "owner-1" });
    first?.run.onAccountLost?.("Signed out.");
    first?.lease.release();
    second?.lease.release();
    expect((await accounts.acquire("chatgpt-web"))?.lease.webAccountId).toBe("old");
  });

  it("is nothing for another runtime, and reads again after a failed read", async () => {
    const read = vi.fn(async () => rows);
    read.mockRejectedValueOnce(new Error("backend unavailable"));
    const { accounts } = swarm(read);
    expect(await accounts.acquire("claude-code")).toBeUndefined();
    await expect(accounts.acquire("chatgpt-web")).rejects.toThrow("backend unavailable");
    expect((await accounts.acquire("chatgpt-web"))?.lease.webAccountId).toBe("default");
  });

  it("uses this machine's profile on a local Inspector", async () => {
    const accounts = createSwarmWebAccounts({
      projectId: "project-1",
      runId: "swarm-run-1",
      getBearer: async () => "token",
      service: null,
    });
    const session = await accounts.acquire("claude-web");
    expect(session?.run.webAccountIds).toEqual(["local:claude"]);
  });
});
