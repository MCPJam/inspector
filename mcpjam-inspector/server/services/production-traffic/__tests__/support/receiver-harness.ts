/**
 * The registered Inspector app (`createHonoApp`, every production middleware)
 * listening on a loopback socket, with a migrated ClickHouse database behind
 * the runtime identity and a stand-in Convex that verifies producer
 * credentials. Shared by the production traffic HTTP suites.
 */
import { randomBytes } from "node:crypto";
import type { ServerType } from "@hono/node-server";
import { vi } from "vitest";
import { migrateProductionTrafficSchema } from "../../clickhouse-schema.js";
import {
  ClickHouseTrafficStore,
  createTrafficClickHouseClient,
} from "../../clickhouse-store.js";
import {
  createClickHouseSandbox,
  type ClickHouseSandbox,
} from "./clickhouse-sandbox.js";
import { startFakeConvex, type FakeConvex } from "./fake-convex.js";

/** Convex-shaped ids, so they pass the routes' id check. */
export const PROJECT = "pt1ordersproject0000000000000001";
export const OTHER_PROJECT = "pt1otherproject00000000000000002";

export const producerToken = () =>
  `mjotlp_${randomBytes(32).toString("base64url")}`;

export type ReceiverHarness = {
  base: string;
  sandbox: ClickHouseSandbox;
  convex: FakeConvex;
  /** A runtime-identity store, to check what a request wrote. */
  store: ClickHouseTrafficStore;
  /** A producer credential for PROJECT, with ingest on. */
  writer: string;
  post(
    body: string | Uint8Array,
    options?: {
      token?: string;
      project?: string;
      headers?: Record<string, string>;
    },
  ): Promise<Response>;
  close(): Promise<void>;
};

export async function startReceiverHarness(
  extraEnv: (convexUrl: string) => Record<string, string> = () => ({}),
): Promise<ReceiverHarness> {
  const serviceToken = `service-${randomBytes(12).toString("hex")}`;
  const sandbox = await createClickHouseSandbox();
  const migration = createTrafficClickHouseClient(sandbox.migration);
  await migrateProductionTrafficSchema(migration);
  await migration.close();

  const convex = await startFakeConvex(serviceToken);
  const writer = producerToken();
  convex.addCredential(writer, PROJECT);
  convex.enableIngest(PROJECT);
  convex.enableIngest(OTHER_PROJECT);

  vi.resetModules();
  const env: Record<string, string> = {
    NODE_ENV: "test",
    DO_NOT_TRACK: "1",
    VITE_MCPJAM_HOSTED_MODE: "false",
    CONVEX_URL: convex.url,
    CONVEX_HTTP_URL: convex.url,
    INSPECTOR_SERVICE_TOKEN: serviceToken,
    PRODUCTION_TRAFFIC_CLICKHOUSE_URL: sandbox.runtime.url,
    PRODUCTION_TRAFFIC_CLICKHOUSE_DATABASE: sandbox.database,
    PRODUCTION_TRAFFIC_CLICKHOUSE_USER: sandbox.runtime.username,
    PRODUCTION_TRAFFIC_CLICKHOUSE_PASSWORD: sandbox.runtime.password,
    ...extraEnv(convex.url),
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { createHonoApp } = await import("../../../../app.js");
  const { serve } = await import("@hono/node-server");
  const { app } = await createHonoApp();
  let server: ServerType | undefined;
  const port = await new Promise<number>((done) => {
    server = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      (info) => done(info.port),
    );
  });
  // Outlive the slow steps between requests, so a reused keep-alive socket
  // is never one the server has already closed.
  if (server && "keepAliveTimeout" in server) server.keepAliveTimeout = 120_000;
  const base = `http://127.0.0.1:${port}`;
  const store = new ClickHouseTrafficStore(
    createTrafficClickHouseClient(sandbox.runtime),
  );

  return {
    base,
    sandbox,
    convex,
    store,
    writer,
    post: async (body, options = {}) => {
      const send = () =>
        fetch(
          `${base}/api/v1/projects/${options.project ?? PROJECT}/otlp/v1/traces`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${options.token ?? writer}`,
              ...options.headers,
            },
            body: typeof body === "string" ? body : new Uint8Array(body),
          },
        );
      // An exporter retries a dropped connection, and a batch is safe to
      // resend; so does this, once, when a reused keep-alive socket was closed.
      try {
        return await send();
      } catch (error) {
        if (
          !/UND_ERR_SOCKET|ECONNRESET/.test(
            String((error as { cause?: { code?: string } }).cause?.code),
          )
        ) {
          throw error;
        }
        return await send();
      }
    },
    close: async () => {
      server?.close();
      await store.close();
      await convex.close();
      await sandbox.dispose();
      vi.unstubAllEnvs();
    },
  };
}
