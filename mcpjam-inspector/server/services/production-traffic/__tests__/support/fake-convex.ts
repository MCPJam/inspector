/**
 * A stand-in for the Convex function the OTLP receiver calls once per batch,
 * `productionIngestService:verify`, served over the real ConvexHttpClient
 * wire protocol (`POST /api/query`) so the receiver runs its production
 * client code in tests. Verdicts follow the backend's rules for the
 * credentials a test registers, and only digests are kept, as in the backend.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hashProducerToken } from "../../producer-verifier.js";

type Credential = {
  projectId: string;
  organizationId: string;
  credentialId: string;
  revoked: boolean;
};

export type FakeConvex = {
  url: string;
  addCredential(token: string, projectId: string): void;
  revoke(token: string): void;
  enableIngest(projectId: string): void;
  close(): Promise<void>;
};

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
  const enabled = new Set<string>();
  let issued = 0;

  const verify = (command: { projectId: string; tokenHash: string }) => {
    const credential = credentials.get(command.tokenHash);
    if (!credential) return { ok: false, reason: "unknown_credential" };
    if (credential.revoked) return { ok: false, reason: "revoked" };
    if (credential.projectId !== command.projectId) {
      return { ok: false, reason: "project_mismatch" };
    }
    if (!enabled.has(credential.projectId)) {
      return { ok: false, reason: "ingest_disabled" };
    }
    return {
      ok: true,
      projectId: credential.projectId,
      organizationId: credential.organizationId,
      credentialId: credential.credentialId,
    };
  };

  const server: Server = createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url !== "/api/query") {
      reply(404, { code: "NotFound" });
      return;
    }
    void readJson(request).then((body) => {
      const { path, args } = body as {
        path: string;
        args: [{ serviceToken?: string; command?: unknown }];
      };
      if (path !== "productionIngestService:verify") {
        reply(404, { code: "UnknownFunction" });
        return;
      }
      if (args[0].serviceToken !== serviceToken) {
        reply(560, {
          status: "error",
          errorMessage: "UNAUTHORIZED",
          errorData: { code: "UNAUTHORIZED" },
          logLines: [],
        });
        return;
      }
      reply(200, {
        status: "success",
        value: verify(
          args[0].command as { projectId: string; tokenHash: string },
        ),
        logLines: [],
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    addCredential: (token, projectId) => {
      issued += 1;
      credentials.set(hashProducerToken(token), {
        projectId,
        organizationId,
        credentialId: `cred_${issued}`,
        revoked: false,
      });
    },
    revoke: (token) => {
      const credential = credentials.get(hashProducerToken(token));
      if (credential) credential.revoked = true;
    },
    enableIngest: (projectId) => enabled.add(projectId),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
