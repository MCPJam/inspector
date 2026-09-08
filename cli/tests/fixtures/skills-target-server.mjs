// Minimal stdio MCP server that SERVES Agent Skills (SEP-2640), used as the
// target for the `mcpjam mcp` skills tools.
//
// It serves three skills on purpose:
//   - `good`     — everything agrees; the happy path.
//   - `tampered` — the manifest digest does not match the bytes served, which
//                  is the case a host that "verifies" but can be talked out of
//                  verifying would happily load.
//   - `dynamic`  — declares `"dynamic"` content, so there is no manifest to
//                  verify against at all.
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const sha256 = (text) =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const bytes = (text) => Buffer.byteLength(text, "utf8");

const GOOD_URI = "skill://demo/good/SKILL.md";
const GOOD_FILE_URI = "skill://demo/good/references/notes.md";
const TAMPERED_URI = "skill://demo/tampered/SKILL.md";
const DYNAMIC_URI = "skill://demo/dynamic/SKILL.md";

const GOOD_MD = `---\nname: good\ndescription: A verifiable skill.\n---\n# Good\n\nDo the thing.\n`;
const GOOD_FILE = "Some supporting notes.\n";
const TAMPERED_MD = `---\nname: tampered\ndescription: Bytes that do not match the manifest.\n---\n# Tampered\n`;

const CONTENTS = {
  [GOOD_URI]: GOOD_MD,
  [GOOD_FILE_URI]: GOOD_FILE,
  [TAMPERED_URI]: TAMPERED_MD,
};

const ENTRIES = [
  {
    uri: GOOD_URI,
    frontmatter: { name: "good", description: "A verifiable skill." },
    resources: [
      { uri: GOOD_URI, digest: sha256(GOOD_MD), size: bytes(GOOD_MD) },
      {
        uri: GOOD_FILE_URI,
        digest: sha256(GOOD_FILE),
        size: bytes(GOOD_FILE),
      },
    ],
  },
  {
    uri: TAMPERED_URI,
    frontmatter: {
      name: "tampered",
      description: "Bytes that do not match the manifest.",
    },
    // The digest of something else entirely, at the length actually served, so
    // the size check passes and only the digest check can catch it.
    resources: [
      {
        uri: TAMPERED_URI,
        digest: sha256("a completely different document"),
        size: bytes(TAMPERED_MD),
      },
    ],
  },
  {
    uri: DYNAMIC_URI,
    frontmatter: { name: "dynamic", description: "Generated per request." },
    resources: "dynamic",
  },
];

const server = new McpServer(
  { name: "skills-target", version: "1.0.0" },
  {
    capabilities: {
      resources: {},
      extensions: { "io.modelcontextprotocol/skills": {} },
    },
  },
);

const looseResult = z.object({}).loose();

server.server.setRequestHandler(
  "skills/list",
  { params: z.object({ cursor: z.string().optional() }).loose(), result: looseResult },
  async () => ({ skills: ENTRIES }),
);

server.server.setRequestHandler(
  "skills/get",
  { params: z.object({ uri: z.string() }).loose(), result: looseResult },
  async (params) => {
    const entry = ENTRIES.find((candidate) => candidate.uri === params.uri);
    if (!entry) {
      const error = new Error(`Unknown skill: ${params.uri}`);
      error.code = -32602;
      throw error;
    }
    return { skill: entry };
  },
);

for (const [uri, text] of Object.entries(CONTENTS)) {
  server.registerResource(
    uri,
    uri,
    { mimeType: "text/markdown" },
    async () => ({ contents: [{ uri, mimeType: "text/markdown", text }] }),
  );
}

await server.connect(new StdioServerTransport());
