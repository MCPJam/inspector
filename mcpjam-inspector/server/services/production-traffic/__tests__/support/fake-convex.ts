/**
 * A stand-in for the Convex functions the production traffic routes call,
 * served over the real ConvexHttpClient wire protocol (`POST /api/query`,
 * `/api/mutation`, `/api/action`) so the routes run their production client
 * code in tests:
 *
 * - `productionIngestService:verify`, the receiver's per-batch check, with the
 *   backend's verdict rules, for the Inspector service token only;
 * - `projects:getProjectCapabilities`, the members' read check;
 * - the admins' `productionIngestCredentials` functions.
 *
 * Callers are told apart by bearer: an unknown one gets the 401 Convex gives,
 * and a member who is not an admin gets the backend's refusal prose. Only
 * digests of producer tokens are kept, as in the backend.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hashProducerToken } from "../../producer-verifier.js";

type Credential = {
  credentialId: string;
  projectId: string;
  organizationId: string;
  revoked: boolean;
};
type Args = Record<string, unknown>;
type Role = "member" | "admin";

export type FakeConvex = {
  url: string;
  addCredential(token: string, projectId: string): string;
  revoke(token: string): void;
  enableIngest(projectId: string): void;
  addMember(bearer: string, projectId: string, role?: Role): void;
  close(): Promise<void>;
};

class Refusal extends Error {}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startFakeConvex(
  serviceToken: string,
  organizationId = "org_fixture",
): Promise<FakeConvex> {
  const credentials = new Map<string, Credential>();
  const enabled = new Map<string, number>();
  const members = new Map<string, Map<string, Role>>();
  let issued = 0;

  const register = (token: string, projectId: string) => {
    issued += 1;
    const credentialId = `pt1credential${String(issued).padStart(19, "0")}`;
    credentials.set(hashProducerToken(token), {
      credentialId,
      projectId,
      organizationId,
      revoked: false,
    });
    return credentialId;
  };
  const byId = (credentialId: unknown) =>
    [...credentials.values()].find((row) => row.credentialId === credentialId);
  const requireAdmin = (bearer: string, projectId: string) => {
    if (members.get(bearer)?.get(projectId) !== "admin") {
      throw new Refusal("Insufficient project permissions: admin");
    }
  };
  const mint = (projectId: string) => {
    const token = `mjotlp_${randomBytes(32).toString("base64url")}`;
    return {
      credentialId: register(token, projectId),
      token,
      displayPrefix: token.slice(0, 13),
    };
  };

  const functions: Record<string, (args: Args, bearer: string) => unknown> = {
    "productionIngestService:verify": (args) => {
      const command = args.command as { projectId: string; tokenHash: string };
      const credential = credentials.get(command.tokenHash);
      if (!credential) return { ok: false, reason: "unknown_credential" };
      if (credential.revoked) return { ok: false, reason: "revoked" };
      if (credential.projectId !== command.projectId) {
        return { ok: false, reason: "project_mismatch" };
      }
      if (!enabled.has(credential.projectId)) {
        return { ok: false, reason: "ingest_disabled" };
      }
      return { ok: true, ...credential };
    },
    "projects:getProjectCapabilities": (args, bearer) => {
      const projectId = args.projectId as string;
      const role = members.get(bearer)?.get(projectId);
      return role
        ? { projectId, organizationId, role, projectRole: null }
        : null;
    },
    "productionIngestCredentials:listForProject": (args, bearer) => {
      requireAdmin(bearer, args.projectId as string);
      return {
        ingestEnabledAt: enabled.get(args.projectId as string) ?? null,
        credentials: [...credentials.values()]
          .filter((row) => row.projectId === args.projectId)
          .map((row) => ({
            credentialId: row.credentialId,
            revokedAt: row.revoked ? 1 : null,
          })),
      };
    },
    "productionIngestCredentials:issue": (args, bearer) => {
      requireAdmin(bearer, args.projectId as string);
      return mint(args.projectId as string);
    },
    "productionIngestCredentials:rotate": (args, bearer) => {
      const previous = byId(args.credentialId);
      if (!previous) throw new Refusal("Producer credential not found");
      requireAdmin(bearer, previous.projectId);
      return mint(previous.projectId);
    },
    "productionIngestCredentials:revoke": (args, bearer) => {
      const row = byId(args.credentialId);
      if (!row) throw new Refusal("Producer credential not found");
      requireAdmin(bearer, row.projectId);
      row.revoked = true;
      return { revokedAt: Date.now() };
    },
    "productionIngestCredentials:setIngestEnabled": (args, bearer) => {
      const projectId = args.projectId as string;
      requireAdmin(bearer, projectId);
      if (args.enabled)
        enabled.set(projectId, enabled.get(projectId) ?? Date.now());
      else enabled.delete(projectId);
      return { enabledAt: enabled.get(projectId) ?? null };
    },
  };

  const server: Server = createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const kind = /^\/api\/(query|mutation|action)$/.exec(
      request.url ?? "",
    )?.[1];
    if (request.method !== "POST" || !kind) {
      reply(404, { code: "NotFound" });
      return;
    }
    void readJson(request).then((body) => {
      const { path, args } = body as { path: string; args: [Args] };
      const run = functions[path];
      if (!run) {
        reply(404, { code: "UnknownFunction" });
        return;
      }
      const isService = path === "productionIngestService:verify";
      if (isService && args[0].serviceToken !== serviceToken) {
        reply(560, {
          status: "error",
          errorMessage: "UNAUTHORIZED",
          errorData: { code: "UNAUTHORIZED" },
          logLines: [],
        });
        return;
      }
      const bearer =
        /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
      if (!isService && !members.has(bearer)) {
        reply(401, {
          code: "Unauthenticated",
          message: "Could not verify token",
        });
        return;
      }
      try {
        reply(200, {
          status: "success",
          value: run(args[0], bearer),
          logLines: [],
        });
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        reply(560, {
          status: "error",
          errorMessage: error.message,
          logLines: [],
        });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    addCredential: register,
    revoke: (token) => {
      const credential = credentials.get(hashProducerToken(token));
      if (credential) credential.revoked = true;
    },
    enableIngest: (projectId) => enabled.set(projectId, Date.now()),
    addMember: (bearer, projectId, role = "member") => {
      const projects = members.get(bearer) ?? new Map<string, Role>();
      projects.set(projectId, role);
      members.set(bearer, projects);
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
