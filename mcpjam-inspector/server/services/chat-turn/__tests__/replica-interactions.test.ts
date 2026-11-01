import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown> & {
  actor: string;
  status: string;
  expiresAt: number;
};
type Envelope = {
  id?: number;
  result?: unknown;
  error?: string;
  ready?: boolean;
  event?: string;
  actor?: string;
  chunk?: { data?: { rendezvousId?: string } };
};
const claims = new Set<string>(),
  rows = new Map<string, Row>(),
  elicitations = new Map<string, Row>();
let effects = 0,
  failClaims = false;
const destinations = new Set<string>();
const backend = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  const actor = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  destinations.add(req.url ?? "");
  if (req.url === "/internal/v1/tool-approvals/claim") {
    if (failClaims) return send({ error: "unavailable" }, 503);
    const key = String(body.nonceHash),
      seen = claims.has(key);
    claims.add(key);
    return send({ status: seen ? "already_claimed" : "claimed" });
  }
  if (req.url === "/side-effect") {
    effects++;
    return send({ effects });
  }
  if (req.url === "/api/mutation") {
    const args = (Array.isArray(body.args) ? body.args[0] : body.args) as Record<string, unknown>;
    const id = String(args.rendezvousId);
    if (body.path === "elicitations:createElicitation") {
      elicitations.set(id, {
        ...args,
        actor,
        status: "pending",
        expiresAt: Date.now() + Number(args.ttlMs),
      });
      return send({ status: "success", value: null });
    }
    const row = elicitations.get(id);
    if (!row || row.actor !== actor)
      return send({ status: "error", errorMessage: "Forbidden" });
    row.status = "answered";
    row.action = args.action;
    row.content = args.content;
    return send({ status: "success", value: null });
  }
  if (req.url?.startsWith("/elicitations/")) {
    const row = elicitations.get(String(body.rendezvousId));
    if (!row) return send({ ok: true, elicitation: null });
    if (req.url.endsWith("cancel")) row.status = "cancelled";
    if (req.url.endsWith("ack")) {
      row.content = undefined;
      row.acked = true;
    }
    return send({ ok: true, elicitation: row });
  }
  if (req.url?.startsWith("/web/mrtr/continuation/")) {
    const id = String(body.continuationId),
      action = req.url.split("/").at(-1);
    if (action === "create") {
      rows.set(id, {
        ...body,
        actor,
        status: "awaiting_input",
        expiresAt: Date.now() + Number(body.ttlMs),
        stateVersion: 0,
        attempt: 0,
        sideEffecting: true,
        round: 0,
        maxRounds: 1,
      });
      return send({ ok: true, ...rows.get(id), createdAt: Date.now() });
    }
    const row = rows.get(id);
    if (!row || row.actor !== actor)
      return send({ ok: false, error: "Forbidden" }, 403);
    if (row.expiresAt <= Date.now()) row.status = "expired";
    if (action === "claim") {
      if (body.bindingFingerprint !== row.bindingFingerprint)
        return send({ ok: false, error: "binding mismatch" }, 409);
      if (row.status !== "awaiting_input")
        return send({
          ok: true,
          status: row.status,
          state: null,
          reason: row.status,
        });
      row.status = "resuming";
      row.leaseId = body.leaseId;
      row.attempt = Number(row.attempt) + 1;
      return send({
        ok: true,
        status: row.status,
        stateVersion: 0,
        state: { ...row },
      });
    }
    if (action === "cancel") {
      row.status = "cancelled";
      return send({ ok: true, status: row.status });
    }
    if (action === "scrub") {
      row.resumeState = undefined;
      return send({ ok: true });
    }
    if (row.leaseId !== body.leaseId)
      return send({ ok: false, error: "wrong lease" }, 409);
    if (action === "mark-wire-started") {
      row.wireStarted = true;
      return send({ ok: true, attempt: row.attempt });
    }
    if (action === "finalize") {
      row.status = String(body.status);
      return send({ ok: true, stateVersion: 1, status: row.status });
    }
  }
  send({ error: "unknown fixture route" }, 404);
});
class Replica {
  child: ChildProcess;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  chunks: Envelope[] = [];
  ready: Promise<void>;
  constructor(origin: string) {
    this.child = fork(
      fileURLToPath(new URL("./fixtures/replica.ts", import.meta.url)),
      [],
      {
        execArgv: ["--import", "tsx"],
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: fileURLToPath(
            new URL("../../../tsconfig.json", import.meta.url),
          ),
          CONVEX_HTTP_URL: origin,
          CONVEX_URL: origin,
          INSPECTOR_SERVICE_TOKEN: "kes733-fixture-service-secret",
          VITE_MCPJAM_HOSTED_MODE: "true",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let errors = "";
    this.child.stderr?.on("data", (chunk) => {
      errors += String(chunk);
    });
    this.ready = new Promise((resolve, reject) => {
      this.child.on("message", (message: Envelope) => {
        if (message.ready) resolve();
        if (message.event) this.chunks.push(message);
        if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending?.reject(new Error(message.error));
          else pending?.resolve(message.result);
        }
      });
      this.child.once("exit", (code) => {
        const error = new Error(
          `Replica exited ${code}: ${errors.slice(-2000)}`,
        );
        reject(error);
        for (const p of this.pending.values()) p.reject(error);
      });
    });
  }
  async call(
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, action, ...args });
    });
  }
  stop() {
    this.child.kill("SIGKILL");
  }
}
let a: Replica, b: Replica, origin: string;
async function waitFor(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Fixture event timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
beforeAll(async () => {
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  a = new Replica(origin);
  b = new Replica(origin);
  await Promise.all([a.ready, b.ready]);
}, 60000);
afterAll(async () => {
  a?.stop();
  b?.stop();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});
describe("production interactions across independent Inspector processes", () => {
  it("has separate process memory and rejects forged local execution", async () => {
    expect(a.child.pid).not.toBe(b.child.pid);
    expect(await a.call("local-route")).toBe(410);
    expect(await b.call("local-route")).toBe(410);
  });
  it("atomically claims a shared signed approval, including after replica restart", async () => {
    const token = await a.call("mint");
    const result = await Promise.all([
      a.call("claim", { token }),
      b.call("claim", { token }),
    ]);
    expect(result.sort()).toEqual(["already_claimed", "claimed"]);
    b.stop();
    b = new Replica(origin);
    await b.ready;
    expect(await b.call("claim", { token })).toBe("already_claimed");
  });
  it("refuses execution when the shared claim store is unavailable", async () => {
    const token = await a.call("mint");
    failClaims = true;
    try {
      expect(await b.call("claim", { token, timeoutMs: 50 })).toBe(
        "unconfirmed",
      );
    } finally {
      failClaims = false;
    }
    expect(await b.call("claim", { token })).toBe("claimed");
  });
  it("resumes an MRTR record on another process and rejects wrong owners and bindings", async () => {
    await a.call("create", { continuationId: "mrtr-cross" });
    expect(
      await b.call("resume", {
        continuationId: "mrtr-cross",
        actor: "actor-b",
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await b.call("resume", {
        continuationId: "mrtr-cross",
        binding: "wrong",
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      await b.call("resume", { continuationId: "mrtr-cross" }),
    ).toMatchObject({
      ok: true,
      status: "resuming",
      state: { resumeState: "opaque-private-state" },
    });
    expect(
      await a.call("resume", { continuationId: "mrtr-cross" }),
    ).toMatchObject({ ok: true, state: null });
  });
  it("does not reclaim expired continuations", async () => {
    await a.call("create", { continuationId: "expired", timeoutMs: -1 });
    expect(await b.call("resume", { continuationId: "expired" })).toMatchObject(
      { ok: true, status: "expired", state: null },
    );
  });
  it("replays a saved scope step-up once on another process", async () => {
    const event = (await a.call("scope-create")) as { continuationId: string };
    const results = await Promise.all([
      a.call("scope-resume", event),
      b.call("scope-resume", event),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "complete" }),
        expect.objectContaining({ kind: "halted" }),
      ]),
    );
    expect(effects).toBe(1);
    expect(await b.call("scope-resume", event)).toMatchObject({
      kind: "halted",
    });
    expect(effects).toBe(1);
  });
  it("delivers an elicitation answer through B while A waits, with tenant isolation", async () => {
    const response = a.call("elicit");
    await waitFor(() =>
      a.chunks.some((chunk) => !!chunk.chunk?.data?.rendezvousId),
    );
    const event = a.chunks.find((chunk) => !!chunk.chunk?.data?.rendezvousId)!;
    const rendezvousId = event.chunk!.data!.rendezvousId;
    await expect(
      b.call("answer", { rendezvousId, actor: "actor-b" }),
    ).rejects.toThrow("Forbidden");
    await b.call("answer", { rendezvousId });
    expect(await response).toEqual({
      action: "accept",
      content: { name: "actor-a" },
    });
    await waitFor(() => elicitations.get(rendezvousId!)?.acked === true);
  });
  it("withdraws pending elicitation on cancellation", async () => {
    const start = a.chunks.length;
    const response = a.call("elicit", { actor: "cancel-actor" });
    await waitFor(() => a.chunks.length > start);
    await a.call("cancel", { actor: "cancel-actor" });
    expect(await response).toEqual({ action: "cancel" });
    expect(
      [...elicitations.values()].filter((row) => row.actor === "cancel-actor"),
    ).toEqual([expect.objectContaining({ status: "cancelled" })]);
  });
});
