/**
 * A web client swarm's accounts: one session per account at a time, the rest
 * queued; a lost account leaves the pool, and with none left a waiting
 * session stops with the reason. Evidence: fixture.
 */
import { describe, expect, it, vi } from "vitest";
import { createSwarmWebAccounts, createWebAccountPool, type SwarmWebSession } from "../swarm-web-accounts";
import { webClientTurnsRunHosted } from "../web-client-environment";
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
        hosted: true,
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
      hosted: false,
    });
    const session = await accounts.acquire("claude-web");
    expect(session?.run.webAccountIds).toEqual(["local:claude"]);
    session?.lease.release();
  });

  it("runs one session at a time on this machine's profile when a local Inspector holds the service credential", async () => {
    // This test process isn't hosted, so the mount gives it the local environment.
    expect(webClientTurnsRunHosted()).toBe(false);
    const read = vi.fn(async () => rows);
    const accounts = createSwarmWebAccounts({
      projectId: "project-1",
      runId: "swarm-run-3",
      getBearer: async () => "token",
      service: { read, apply: vi.fn() },
      actorOf: async () => ({ actorUserId: "owner-1" }),
    });
    const first = await accounts.acquire("chatgpt-web");
    let second: SwarmWebSession | undefined;
    const waiting = accounts
      .acquire("chatgpt-web")
      .then((session) => (second = session));
    await settled();
    // The project's two signed-in accounts would put both sessions on the one profile at once.
    expect(second).toBeUndefined();
    first?.lease.release();
    await waiting;
    expect([first?.run.webAccountIds, second?.run.webAccountIds]).toEqual([
      ["local:chatgpt"],
      ["local:chatgpt"],
    ]);
    expect(read).not.toHaveBeenCalled();
    second?.lease.release();
  });

  it("holds no account on a hosted server without the backend, so the turn says it isn't set up", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    try {
      const accounts = createSwarmWebAccounts({
        projectId: "project-1",
        runId: "swarm-run-4",
        getBearer: async () => "token",
        hosted: true,
      });
      expect(await accounts.acquire("chatgpt-web")).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  const localSwarm = () =>
    createSwarmWebAccounts({
      projectId: "project-1",
      runId: "swarm-run-2",
      getBearer: async () => "token",
      hosted: false,
    });

  it("makes a second local swarm wait for this machine's profile until the first is done with it", async () => {
    const first = localSwarm();
    const second = localSwarm();
    const held = await first.acquire("chatgpt-web");
    let waited: SwarmWebSession | undefined;
    const waiting = second.acquire("chatgpt-web").then((session) => (waited = session));
    await settled();
    expect(waited).toBeUndefined();
    held?.lease.release();
    await waiting;
    expect(waited?.run.webAccountIds).toEqual(["local:chatgpt"]);
    // A session that loses the account still hands the profile on, and only
    // its own swarm stops using it.
    const third = localSwarm().acquire("chatgpt-web");
    waited?.run.onAccountLost?.("ChatGPT needs sign-in.");
    const next = await third;
    expect(next?.run.webAccountIds).toEqual(["local:chatgpt"]);
    await expect(second.acquire("chatgpt-web")).rejects.toThrow("ChatGPT needs sign-in.");
    next?.lease.release();
  });

  it("gives the swarm its account back when a session stops waiting for the profile", async () => {
    const first = localSwarm();
    const second = localSwarm();
    const held = await first.acquire("chatgpt-web");
    const stop = new AbortController();
    const waiting = second.acquire("chatgpt-web", stop.signal);
    await settled();
    stop.abort(new Error("The swarm was stopped."));
    await expect(waiting).rejects.toThrow("The swarm was stopped.");
    held?.lease.release();
    const next = await second.acquire("chatgpt-web");
    expect(next?.run.webAccountIds).toEqual(["local:chatgpt"]);
    next?.lease.release();
  });
});
