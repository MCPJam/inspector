import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";

/**
 * Ratchet for MJ-006: every byte upload the browser makes goes to a route
 * that takes the bytes and answers with a storage id — the backend's upload
 * route (`@/shared/blob-upload`), the plugin bundle route, the profile-picture
 * routes, or the inspector's own archive upload. None asks anything for an
 * upload URL first.
 *
 * Scans the client source and the `shared/` modules it bundles. If this fails
 * because you added an upload, send the bytes through `useConvexBlobUpload`
 * (or `uploadBlobAsApiActor` outside React) instead.
 */

const CLIENT_SRC = resolve(fileURLToPath(import.meta.url), "../../..");
const SHARED_SRC = resolve(CLIENT_SRC, "../../shared");

/** Convex upload-URL mutations, and HTTP routes that hand one out. */
const UPLOAD_URL_ISSUER_PATTERN =
  /\bgenerate[A-Za-z]*UploadUrl\b|["'`/][A-Za-z0-9/_-]*upload-url\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("byte upload ratchet (MJ-006)", () => {
  it("never asks for an upload URL from client or shared code", () => {
    const offenders = [
      ...sourceFiles(CLIENT_SRC).map((file) => ({ root: CLIENT_SRC, file })),
      ...sourceFiles(SHARED_SRC).map((file) => ({ root: SHARED_SRC, file })),
    ]
      .filter(({ file }) =>
        UPLOAD_URL_ISSUER_PATTERN.test(readFileSync(file, "utf8")),
      )
      .map(({ root, file }) => relative(root, file).split(sep).join("/"));

    expect(offenders).toEqual([]);
  });

  it("sends the uploaders' bytes to the backend's upload route", () => {
    const helper = readFileSync(join(SHARED_SRC, "blob-upload.ts"), "utf8");
    expect(helper).toContain('BLOB_UPLOAD_PATH = "/web/uploads/blob"');

    for (const uploader of [
      "hooks/useSharedChatWidgetCapture.ts",
      "hooks/useViews.ts",
      "components/evals/eval-attachments-editor.tsx",
    ]) {
      expect(
        readFileSync(join(CLIENT_SRC, uploader), "utf8"),
        uploader,
      ).toContain("useConvexBlobUpload");
    }
    expect(
      readFileSync(join(CLIENT_SRC, "lib/apis/mcp-skills-api.ts"), "utf8"),
    ).toContain("uploadBlobAsApiActor");
  });

  it("recognizes the shapes it guards against", () => {
    for (const sample of [
      'useMutation("chatSessions:generateSnapshotUploadUrl")',
      'useMutation("testSuites:generateEvalAttachmentUploadUrl")',
      'webPost("/api/web/skills/files/upload-url", body)',
      'postJson("upload-url", { projectId })',
      "`${base}/direct-chat/widget-snapshot/generate-upload-url`",
    ]) {
      expect(UPLOAD_URL_ISSUER_PATTERN.test(sample), sample).toBe(true);
    }
    for (const sample of [
      "buildComputerUploadUrl()",
      'new URL("/plugin-bundle-upload", siteUrl)',
      '"/web/uploads/blob"',
    ]) {
      expect(UPLOAD_URL_ISSUER_PATTERN.test(sample), sample).toBe(false);
    }
  });
});
