/**
 * Computer file upload (`POST /api/web/computers/upload`).
 *
 * Drag-and-drop files from the browser Shell panel straight into the user's
 * project computer (E2B). The files land under a stable absolute root
 * (`/home/user/uploads`); the user then references that path in chat so the
 * Claude Code harness's native `Read` tool can open them (the harness prompt
 * channel is text-only and can't carry image/file parts — see
 * server/utils/harness/run-harness-turn.ts).
 *
 * Auth mirrors the terminal WebSocket (routes/web/computer-terminal.ts):
 *   - The browser mints a ~60s Convex terminal token and sends it as
 *     `Authorization: Bearer <jwt>` (a `?token=` query fallback is kept one
 *     release for stale tabs open across a deploy — headers stay out of
 *     access/proxy logs, query strings don't).
 *   - We verify it LOCALLY (shared HS256 secret) → `computerId`, then exchange
 *     it for the vendor sandbox id via the secret-gated `/computers/sandbox-info`
 *     control-plane route. The browser never sees vendor ids or credentials.
 *
 * An upload is strictly WEAKER than the Shell it sits next to: anyone holding a
 * terminal token can already run arbitrary commands in the box (`cat > file`).
 * So the only gate that matters for tenant isolation is reusing that
 * computer-scoped token; the rest is hygiene — path confinement (no traversal
 * out of the upload root), size/count caps (no disk-fill), and a friendly
 * failure when the box is asleep.
 *
 * The 30 MB body cap is applied by a route-specific `bodyLimit` at the mount
 * site (server/index.ts); the global `/api/web/*` 1 MB cap excludes this path.
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "hono";
import { Sandbox } from "e2b";
import { verifyComputerTerminalToken } from "../../utils/computers/terminal-token.js";
import {
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
} from "../../utils/computers/control-plane-client.js";
import { logger } from "../../utils/logger.js";
import { classifyError } from "../../utils/error-classify.js";

/** The box home. The client may request a specific destination dir (the Shell's
 *  cwd — e.g. the harness session workdir `/home/user/claude-code-<id>`); we
 *  confine any requested dir under this root and fall back to `UPLOAD_ROOT`. */
const HOME_ROOT = "/home/user";
/** Fallback destination when the client provides no (or an invalid) target dir
 *  — e.g. a plain computer host, or the Shell opened before any harness turn. */
const UPLOAD_ROOT = "/home/user/uploads";
const MAX_DIR_LEN = 1024;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

/** Narrow structural view of the E2B sandbox — only the file ops we need, so
 *  tests can inject a fake without the full SDK surface. `Sandbox` satisfies it. */
export interface UploadSandbox {
  files: {
    makeDir(path: string): Promise<boolean>;
    write(path: string, data: ArrayBuffer): Promise<unknown>;
  };
}

export interface ComputerUploadDeps {
  /** Connect to a live sandbox by vendor id. Defaults to E2B `Sandbox.connect`
   *  (which auto-resumes a paused box, like the terminal route). */
  connectSandbox?: (sandboxId: string) => Promise<UploadSandbox>;
}

/** Resolve the destination directory. The client passes the Shell's cwd (the
 *  harness workdir) so uploads land where the user is actually working, not in a
 *  detached bucket. We confine it under the box home and reject traversal; any
 *  missing/invalid value falls back to `UPLOAD_ROOT`. This is hygiene, not a
 *  trust boundary — the terminal token already grants full shell write access —
 *  but it keeps the endpoint from being a write-anywhere primitive and avoids
 *  footguns like a stray dir landing files in `/etc`. */
function resolveUploadDir(requested: string | undefined): string {
  if (!requested || requested.length > MAX_DIR_LEN) return UPLOAD_ROOT;
  if (!requested.startsWith("/")) return UPLOAD_ROOT;
  const normalized = posix.normalize(requested).replace(/\/+$/, "");
  if (normalized !== HOME_ROOT && !normalized.startsWith(`${HOME_ROOT}/`)) {
    return UPLOAD_ROOT;
  }
  if (normalized.split("/").includes("..")) return UPLOAD_ROOT;
  return normalized;
}

/** Turn a user-supplied filename into a safe, collision-free basename. Strips
 *  any path, neutralizes odd characters, and prefixes a short random id — the
 *  prefix is what guarantees a drop into a shared harness workdir can't clobber
 *  a file the model just wrote. Never returns `.`/`..` or an empty name. */
function safeUploadName(rawName: string): string {
  const base = posix.basename(rawName || "");
  const cleaned = base.replace(/[^\w.\- ]/g, "_").trim();
  const safe = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
  return `${randomUUID().slice(0, 8)}-${safe}`;
}

export function createComputerUploadHandler(deps: ComputerUploadDeps = {}) {
  const connectSandbox =
    deps.connectSandbox ??
    ((id: string) => Sandbox.connect(id) as unknown as Promise<UploadSandbox>);

  return async (c: Context): Promise<Response> => {
    if (!isComputersDataPlaneConfigured()) {
      return c.json(
        { ok: false, error: "Computers are not configured on this server." },
        503
      );
    }

    // ── auth: terminal token → computerId → vendor sandbox id ──────────────
    const authHeader = c.req.header("authorization") ?? "";
    const bearer = /^bearer\s+/i.test(authHeader)
      ? authHeader.replace(/^bearer\s+/i, "").trim()
      : "";
    // `?token=` fallback: remove after one release (see header comment).
    const token = bearer || c.req.query("token") || "";
    const claims = await verifyComputerTerminalToken(token);
    if (!claims) {
      return c.json(
        { ok: false, error: "Invalid or expired terminal token." },
        401
      );
    }
    const info = await getComputerSandboxInfo({ computerId: claims.computerId });
    if (!info.ok) {
      return c.json(
        { ok: false, error: `Computer unavailable: ${info.error}` },
        503
      );
    }
    if (!info.value.providerComputerId) {
      return c.json({ ok: false, error: "Computer is still provisioning." }, 503);
    }
    const sandboxId = info.value.providerComputerId;

    // ── body: multipart files, with count/size caps ───────────────────────
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ ok: false, error: "Expected multipart/form-data." }, 400);
    }
    const files = formData
      .getAll("files")
      .filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return c.json({ ok: false, error: "No files uploaded." }, 400);
    }
    if (files.length > MAX_FILES) {
      return c.json(
        { ok: false, error: `Too many files (max ${MAX_FILES}).` },
        413
      );
    }
    let totalBytes = 0;
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) {
        return c.json(
          {
            ok: false,
            error: `File "${f.name}" exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB per-file limit.`,
          },
          413
        );
      }
      totalBytes += f.size;
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      return c.json(
        { ok: false, error: "Upload exceeds the total size limit." },
        413
      );
    }

    const targetDir = resolveUploadDir(c.req.query("dir"));
    const planned = files.map((f) => {
      const name = safeUploadName(f.name);
      return { file: f, name, path: `${targetDir}/${name}` };
    });

    // ── write into the box ─────────────────────────────────────────────────
    let sandbox: UploadSandbox;
    try {
      sandbox = await connectSandbox(sandboxId);
    } catch (err) {
      logger.warn("[computer-upload] sandbox connect failed", {
        computerId: claims.computerId,
        errorCode: classifyError(err),
      });
      return c.json(
        {
          ok: false,
          error:
            "Your computer is asleep — send a message in chat to wake it, then try again.",
        },
        503
      );
    }

    try {
      // Idempotent; makeDir on an existing path is a no-op/false, not an error.
      await sandbox.files.makeDir(targetDir);
    } catch {
      // Best-effort: the write below surfaces a genuine permissions problem.
    }

    const written: { name: string; path: string; bytes: number }[] = [];
    try {
      for (const p of planned) {
        const buf = await p.file.arrayBuffer();
        await sandbox.files.write(p.path, buf);
        written.push({ name: p.name, path: p.path, bytes: p.file.size });
      }
    } catch (err) {
      logger.warn("[computer-upload] write failed", {
        computerId: claims.computerId,
        errorCode: classifyError(err),
      });
      return c.json(
        { ok: false, error: "Failed to write files to your computer." },
        502
      );
    }

    logger.info("[computer-upload] uploaded", {
      computerId: claims.computerId,
      count: written.length,
      totalBytes,
    });
    return c.json({ ok: true, files: written });
  };
}
