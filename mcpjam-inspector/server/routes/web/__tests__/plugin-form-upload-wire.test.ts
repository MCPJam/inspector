import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const state = vi.hoisted(() => ({ root: "", expiresAt: 0, admitted: true }));
vi.mock("../../../services/evals/route-helpers.js", () => ({
  createConvexClient: () => ({
    query: async () => ({ actorId: "actor", expiresAt: state.expiresAt }),
  }),
}));
vi.mock(
  "../../../services/plugin-host/form-file-grants.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../../services/plugin-host/form-file-grants.js")
      >();
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    state.root = await mkdtemp(join(tmpdir(), "plugin-multipart-wire-"));
    return {
      ...actual,
      pluginFormFileGrants: new actual.PluginFormFileGrants(state.root),
    };
  },
);
vi.mock("../../../services/plugin-host/admission.js", async (original) => ({
  ...(await original<
    typeof import("../../../services/plugin-host/admission.js")
  >()),
  admitPluginWorkspace: async () => {
    if (!state.admitted) throw new Error("fixture authorization refused");
    return { actorId: "actor", projectId: "project", workspaceId: "workspace" };
  },
}));
vi.mock(
  "../../../services/plugin-host/request-runtime.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../services/plugin-host/request-runtime.js")
    >()),
    createPluginRequestRuntime: () => ({
      resolve: async () => ({
        revision: "tool-revision",
        hostRevision: "host-revision",
        bindingId: "binding",
        manager: { getServerConfig: () => ({ command: "node" }) },
        extensions: { capabilities: { forms: true, fileResources: true } },
      }),
      release: async () => {},
    }),
  }),
);
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "fixture-bearer",
}));
vi.mock("../../../utils/tool-approval-token.js", () => ({
  toolApprovalSubjectFromAuthHeader: () => "subject",
}));

import routes from "../plugin-instances";
import { pluginInstances } from "../../../services/plugin-host/instances";
import {
  pluginFormSources,
  type PluginFormSource,
} from "../../../services/plugin-host/form-sources";
import { pluginFormFileGrants } from "../../../services/plugin-host/form-file-grants";

const owner = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "workspace",
  instanceId: "instance",
  generation: 1,
  serverId: "server",
  bindingId: "binding",
  placement: "interactive" as const,
};
let server: Server;
let base: string;
let source: PluginFormSource;
let token: string;
let closeOwner: () => void;
let closeSource: () => void;
const consume = promisify(execFile);
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

beforeEach(async () => {
  state.admitted = true;
  state.expiresAt = Date.now() + 60_000;
  closeOwner = pluginInstances.retainModelOwner(
    {
      owner,
      subject: "subject",
      hostId: "host",
      hostRevision: "host-revision",
      serverIdentity: { kind: "standalone", serverId: "server" },
    },
    new AbortController().signal,
  );
  const app = new Hono().route("/api/web/apps/plugin-instances", routes);
  server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test listener");
  base = `http://127.0.0.1:${address.port}/api/web/apps/plugin-instances`;
});
afterEach(async () => {
  closeSource?.();
  pluginFormFileGrants.closeOwner(owner);
  await pluginFormFileGrants.drain();
  closeOwner();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await rm(state.root, { recursive: true, force: true });
});

function bind(
  kind: "file" | "directory",
  selection: "single" | "explicit" | "implicit",
) {
  const field = {
    ...(selection === "single"
      ? { type: "string", format: "uri" }
      : { type: "array", items: { type: "string", format: "uri" } }),
    "x-openai-input": {
      type: "resource",
      options: [],
      userOptions: { kind, accept: [".txt"] },
      ...(selection === "implicit" ? { selection } : {}),
    },
  };
  source = {
    owner,
    hostId: "host",
    hostRevision: "host-revision",
    invocationId: crypto.randomUUID(),
    origin: "model",
    revision: "tool-revision",
    toolName: "consume",
    uploadTarget: "local-stdio",
    fileResources: true,
    parent: {
      kind: "mrtr",
      id: crypto.randomUUID(),
      round: 1,
      inputRequestKey: "choice",
    },
    requestedSchema: {
      type: "object",
      required: ["files"],
      properties: { files: field },
    },
    expiresAt: state.expiresAt,
  };
  const bound = pluginFormSources.bind(source);
  token = bound.token;
  closeSource = bound.release;
}

type PickedFile = { name: string; bytes: Uint8Array; relativePath?: string };
async function upload(
  files: PickedFile[],
  operationId: string,
  overrides = {},
) {
  const body = new FormData();
  body.append(
    "request",
    JSON.stringify({
      projectId: "project",
      pluginWorkspace: { version: 1, workspaceId: "workspace" },
      sourceToken: token,
      parent: source.parent,
      field: "files",
      operationId,
      ...(files[0]?.relativePath
        ? { relativePaths: files.map((file) => file.relativePath) }
        : {}),
      ...overrides,
    }),
  );
  for (const file of files)
    body.append(
      "files",
      new Blob([file.bytes], { type: "text/plain" }),
      file.name,
    );
  return fetch(`${base}/form-files/upload`, {
    method: "POST",
    body,
    headers: { authorization: "Bearer fixture" },
  });
}

describe("physical multipart form uploads", () => {
  it.each([
    ["file", "single"],
    ["file", "explicit"],
    ["file", "implicit"],
    ["directory", "single"],
    ["directory", "explicit"],
    ["directory", "implicit"],
  ] as const)(
    "places %s/%s bytes and retains only through their operation",
    async (kind, selection) => {
      bind(kind, selection);
      const files =
        kind === "directory"
          ? [
              {
                name: "π.txt",
                relativePath: "chosen/nested/π.txt",
                bytes: Buffer.concat([
                  Buffer.from("one\0<script>literal</script>"),
                  Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
                ]),
              },
              {
                name: "π.txt",
                relativePath: "chosen/π.txt",
                bytes: Buffer.from("two 🧩"),
              },
            ]
          : [
              {
                name: "π.txt",
                bytes: Buffer.concat([
                  Buffer.from("exact\0🧩<script>literal</script>"),
                  Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
                ]),
              },
            ];
      const operationId = crypto.randomUUID();
      const response = await upload(files, operationId);
      expect(response.status).toBe(200);
      const { uris } = (await response.json()) as { uris: string[] };
      const duplicate = await upload(files, operationId);
      expect(await duplicate.json()).toEqual({ uris });
      expect(await readdir(state.root)).toHaveLength(1);
      const delivered = pluginFormFileGrants.deliver(source, token, {
        files: selection === "single" ? uris[0] : uris,
      });
      const targets = Array.isArray(delivered.files)
        ? delivered.files
        : [delivered.files];
      const root = fileURLToPath(String(targets[0]));
      closeSource();
      // The consumer reads physical paths after the schema/source window has closed.
      for (let index = 0; index < files.length; index++) {
        const path =
          kind === "directory"
            ? join(root, ...files[index]!.relativePath!.split("/").slice(1))
            : fileURLToPath(String(targets[index]));
        const { stdout } = await consume(process.execPath, ["-e",
          'const b=require("node:fs").readFileSync(process.argv[1]); process.stdout.write(JSON.stringify({bytes:b.length,sha256:require("node:crypto").createHash("sha256").update(b).digest("hex")}))',
          path,
        ]);
        expect(JSON.parse(stdout)).toEqual({
          bytes: files[index]!.bytes.length, sha256: digest(files[index]!.bytes),
        });
      }
      pluginFormFileGrants.closeOperation(owner, source.invocationId);
      await pluginFormFileGrants.drain();
      expect(await readdir(state.root)).toEqual([]);
    },
  );

  it("rejects cross-field and cross-round requests before physical placement", async () => {
    bind("file", "single");
    const files = [{ name: "safe.txt", bytes: Buffer.from("safe") }];
    for (const overrides of [
      { field: "different" },
      { parent: { ...source.parent, round: 2 } },
      { sourceToken: "a".repeat(43) },
    ])
      expect((await upload(files, crypto.randomUUID(), overrides)).status).toBe(
        403,
      );
    expect(await readdir(state.root)).toEqual([]);
  });

  it.each([
    ["chosen/../unsafe.txt", "chosen/safe.txt"],
    ["chosen/A/safe.txt", "chosen/a/safe.txt"],
  ])(
    "rejects unsafe directory hierarchy before writing %s",
    async (first, second) => {
      bind("directory", "single");
      const response = await upload(
        [
          {
            name: first.split("/").at(-1)!,
            relativePath: first,
            bytes: Buffer.from("first"),
          },
          {
            name: second.split("/").at(-1)!,
            relativePath: second,
            bytes: Buffer.from("second"),
          },
        ],
        crypto.randomUUID(),
      );
      expect(response.status).toBe(403);
      expect(await readdir(state.root)).toEqual([]);
    },
  );

  it("cleans unpromoted bytes when the original source closes", async () => {
    bind("file", "single");
    const result = await upload(
      [{ name: "safe.txt", bytes: Buffer.from("safe") }],
      crypto.randomUUID(),
    );
    expect(result.status).toBe(200);
    closeSource();
    await pluginFormFileGrants.drain();
    expect(await readdir(state.root)).toEqual([]);
  });
});
