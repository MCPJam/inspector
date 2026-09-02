/**
 * Local-harness control routes — `/api/mcp/local-harness/*`.
 *
 * Everything the renderer needs to offer "Native on this machine": what the
 * machine can do, which directory has been granted, whether the runtime is
 * installed, and the consent capability that lets a turn actually run there.
 *
 * ── Why /api/mcp and not /api/web ────────────────────────────────────────
 * The global session middleware protects `/api/mcp` with the inspector session
 * token, so a random page cannot drive these cross-origin. On top of that every
 * request must carry a VERIFIED sign-in — `bearerAuthMiddleware` labels an
 * unrecognized bearer `unverified_passthrough`, and `requireVerifiedAuth`
 * rejects exactly that. These routes never forward the bearer to Convex on the
 * consent path, so without it a bare `Authorization: Bearer whatever` would
 * mint a consent capability for somebody's filesystem.
 *
 * Guests are refused explicitly. The kill switch 404s everything, and the
 * routes are additionally never meaningful hosted, where it is forced off.
 *
 * ── What a renderer may and may not say ──────────────────────────────────
 * Nothing here accepts a path from a renderer under normal circumstances. The
 * Electron picker runs in the MAIN process and hands the path over IPC; the npx
 * server accepts one only from a same-origin, loopback request, which is the
 * `npx` user's own browser talking to their own machine — and even then it is
 * canonicalized and re-checked by `registerWorkspaceGrant`. What comes back is
 * an opaque id and a tilde-shortened display root, never an absolute path.
 */
import { Hono } from "hono";
import { homedir } from "node:os";
import { HOSTED_MODE, LOCAL_HARNESS_ENABLED } from "../../config.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { isAllowedRequestOrigin } from "../../middleware/origin-validation.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import { logger } from "../../utils/logger.js";
import {
  LOCAL_HARNESS_MANIFEST,
  resolveLocalCompatibility,
} from "../../utils/harness/local/compatibility.js";
import {
  getLocalMachineId,
  grantLocalHarnessConsent,
  registerWorkspaceGrant,
  resolveWorkspaceGrant,
  revokeLocalHarnessGrants,
  type HarnessGrantBinding,
} from "../../utils/harness/local/grants.js";
import {
  instanceKeyFingerprint,
  readLocalInstanceIdentity,
  setRegisteredKeyId,
} from "../../utils/harness/local/instance-key.js";
import {
  installRuntimePack,
  readRuntimeInstallStatus,
  runtimeInstallRoot,
  type RuntimeInstallStatus,
} from "../../utils/harness/local/runtime-install.js";
import { resolveManagedBundle } from "../../utils/harness/local/runtime-identity.js";
import { supportsOwnershipProof } from "../../utils/harness/local/process-identity.js";
import {
  currentLocalPlatform,
  LOCAL_HARNESS_POLICY_VERSION,
  type LocalPermissionProfile,
} from "../../utils/harness/local/targets.js";
import { registerLocalInstance } from "../../utils/harness/harness-model-broker.js";
import { stopAllLocalHarnessSessions } from "../../utils/harness/local/session-registry.js";

const localHarness = new Hono();

localHarness.use("/*", bearerAuthMiddleware, requireVerifiedAuth());
localHarness.use("/*", async (c, next) => {
  // The kill switch answers 404, not 403: an operator who turned the feature
  // off should not have the surface advertise that it exists.
  if (!LOCAL_HARNESS_ENABLED || HOSTED_MODE) {
    return c.json({ error: "Not found" }, 404);
  }
  if (c.get("guestId")) {
    return c.json(
      { error: "Guests cannot run a harness on this machine" },
      403,
    );
  }
  return next();
});

/**
 * The signed-in user, from whichever identity the bearer middleware resolved.
 *
 * `requireVerifiedAuth` has already rejected an unverified bearer, so reaching
 * here means one of these is set; which one depends on how the request
 * authenticated, and consent does not care as long as it is a stable id.
 */
function resolveConsentUserId(c: {
  get: (key: string) => unknown;
  req: { header: (name: string) => string | undefined };
}): string | null {
  for (const key of ["mcpjamUserId", "workosUserId", "userId"]) {
    const value = c.get(key);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Shorten a path for display: `~/code/project`, never `/Users/marcelo/...`.
 *
 * The absolute path is local trusted state. It goes to a renderer nowhere, and
 * to telemetry nowhere — a home directory carries the user's name on most
 * machines, and a checkout path carries their employer's.
 */
function displayRoot(canonicalPath: string): string {
  const home = homedir();
  if (canonicalPath === home) return "~";
  if (canonicalPath.startsWith(`${home}/`)) {
    return `~${canonicalPath.slice(home.length)}`;
  }
  return canonicalPath;
}

/**
 * `GET /availability` — everything the selector and the consent sheet render
 * from, with no absolute paths and no secrets.
 */
localHarness.get("/availability", async (c) => {
  const platform = currentLocalPlatform(process.platform);
  const manifest = LOCAL_HARNESS_MANIFEST["claude-code"];

  const compatibility =
    platform === null
      ? null
      : resolveLocalCompatibility(
          {
            harnessId: "claude-code",
            platform,
            targetKind: "local-native",
            permissionProfile: "workspace-edits",
            installedAdapterVersion: manifest.adapterVersion,
          },
          LOCAL_HARNESS_MANIFEST,
        );

  const runtimeStatus = await readRuntimeInstallStatus({
    harnessId: "claude-code",
  });

  let machineId: string | null = null;
  let keyFingerprint: string | null = null;
  try {
    const identity = await readLocalInstanceIdentity();
    machineId = identity.machineId;
    keyFingerprint = instanceKeyFingerprint(identity.publicKey);
  } catch (error) {
    // A machine identity we cannot establish is a refusal, not a crash: the
    // availability gate reports `machine-identity-unavailable` for the same
    // reason, and the UI shows it rather than a blank panel.
    logger.warn("[local-harness] machine identity unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // The runtime's own identity — version and digest — is what the consent sheet
  // shows so a user can see WHAT they are about to run. Only resolvable once a
  // pack is installed.
  let runtime: {
    runtimeId: string;
    adapterVersion: string;
    digest: string;
    vendorPackages: Readonly<Record<string, string>>;
  } | null = null;
  if (runtimeStatus.state === "ready" && platform !== null) {
    const resolved = await resolveManagedBundle({
      manifest,
      runtimeRoot: runtimeStatus.runtimeRoot,
      platform,
    });
    if (resolved.ok) {
      runtime = {
        runtimeId: resolved.runtime.runtimeId,
        adapterVersion: resolved.runtime.adapterVersion,
        digest: resolved.runtime.digest,
        vendorPackages: resolved.runtime.vendorPackages,
      };
    }
  }

  const ownershipProvable = supportsOwnershipProof(process.platform);

  return c.json({
    available:
      compatibility?.ok === true && ownershipProvable && runtime !== null,
    // A named status the UI can render specifically, rather than a boolean it
    // has to guess a reason for.
    status:
      platform === null
        ? "platform-not-supported"
        : !ownershipProvable
          ? "ownership-unprovable"
          : compatibility?.ok !== true
            ? compatibility?.status
            : runtime === null
              ? "runtime-unavailable"
              : "ok",
    message:
      compatibility?.ok === false
        ? compatibility.message
        : !ownershipProvable
          ? `this Inspector cannot prove ownership of a process tree on ` +
            `${process.platform}, so it could not guarantee that stopping a ` +
            `session stops everything it started`
          : null,
    platform: process.platform,
    machineId,
    keyFingerprint,
    permissionProfile: "workspace-edits" satisfies LocalPermissionProfile,
    policyVersion: LOCAL_HARNESS_POLICY_VERSION,
    runtime,
    runtimeStatus,
    runtimeRootConfigured: runtimeInstallRoot() !== "",
  });
});

/** `GET /runtime/status` — cheap enough to poll while an install runs. */
localHarness.get("/runtime/status", async (c) => {
  return c.json(await readRuntimeInstallStatus({ harnessId: "claude-code" }));
});

/**
 * `POST /runtime/install` — the explicit "Install local runtime" step.
 *
 * Long-running by nature (a ~200 MB download), and single-flight in the
 * installer, so a second caller joins the first rather than starting a second
 * extraction. The UI polls `/runtime/status` for progress.
 */
localHarness.post("/runtime/install", async (c) => {
  let last: RuntimeInstallStatus | null = null;
  const result = await installRuntimePack({
    harnessId: "claude-code",
    onProgress: (status) => {
      last = status;
    },
  });
  if (result.state !== "ready") {
    logger.warn("[local-harness] runtime install did not complete", {
      state: result.state,
      lastState: last === null ? null : (last as RuntimeInstallStatus).state,
    });
  }
  return c.json(result);
});

/**
 * `POST /workspace-grant` — register the directory a turn may work in.
 *
 * The path never comes from a renderer's typed input. On Electron it arrives
 * from the main-process picker over IPC (which calls this route on loopback
 * with the nonce that proves it). On npx the request must be same-origin and
 * loopback, which is the user's own browser on their own machine — and even
 * then the path is canonicalized and re-checked before it becomes a grant.
 */
localHarness.post("/workspace-grant", async (c) => {
  if (!isAllowedRequestOrigin(c.req.header("origin"))) {
    // Re-checked INSIDE the handler, not only in middleware: an absent Origin
    // is rejected here, which is the case a middleware ordering change is most
    // likely to let through.
    return c.json({ error: "Origin not allowed" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    path?: unknown;
  } | null;
  const path = typeof body?.path === "string" ? body.path.trim() : "";
  if (path.length === 0) {
    return c.json({ error: "A workspace path is required" }, 400);
  }

  const registered = await registerWorkspaceGrant(path);
  if (!registered.ok) {
    return c.json({ error: registered.message }, 400);
  }
  return c.json({
    workspaceGrantId: registered.grant.workspaceGrantId,
    // Display only. The absolute path stays on this side.
    displayRoot: displayRoot(registered.grant.canonicalPath),
  });
});

/**
 * `POST /consent/grant` — mint the capability a local turn presents.
 *
 * Every identity in the binding is RE-DERIVED here rather than taken from the
 * request: the machine id from this installation, the runtime id by resolving
 * the installed pack, the workspace by looking the grant id up. What the caller
 * supplies is which project and which workspace grant — the two things it is
 * entitled to choose — and everything else is what the server can prove.
 *
 * The registration of this machine's instance key happens here too, because
 * consent is exactly when a user agrees to this installation running work on
 * their behalf.
 */
localHarness.post("/consent/grant", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
    workspaceGrantId?: unknown;
  } | null;
  const projectId =
    typeof body?.projectId === "string" ? body.projectId : null;
  const workspaceGrantId =
    typeof body?.workspaceGrantId === "string" ? body.workspaceGrantId : null;
  if (!projectId || !workspaceGrantId) {
    return c.json(
      { error: "projectId and workspaceGrantId are required" },
      400,
    );
  }
  // The signed-in identity, as `bearerAuthMiddleware` resolved it. Never taken
  // from the request body: consent binds to a user, and a user the caller names
  // is a user the caller chose.
  const userId = resolveConsentUserId(c);
  if (userId === null) {
    return c.json({ error: "A signed-in member is required" }, 403);
  }

  const workspace = await resolveWorkspaceGrant(workspaceGrantId);
  if (!workspace.ok) {
    return c.json({ error: workspace.message }, 400);
  }

  const runtimeStatus = await readRuntimeInstallStatus({
    harnessId: "claude-code",
  });
  if (runtimeStatus.state !== "ready") {
    return c.json(
      {
        error:
          "The local runtime is not installed yet, so there is nothing to " +
          "consent to running.",
        runtimeStatus,
      },
      409,
    );
  }
  const platform = currentLocalPlatform(process.platform);
  if (platform === null) {
    return c.json({ error: "This platform has no local harness" }, 400);
  }
  const resolved = await resolveManagedBundle({
    manifest: LOCAL_HARNESS_MANIFEST["claude-code"],
    runtimeRoot: runtimeStatus.runtimeRoot,
    platform,
  });
  if (!resolved.ok) {
    return c.json({ error: resolved.message }, 409);
  }

  let machineId: string;
  try {
    machineId = await getLocalMachineId();
  } catch (error) {
    return c.json(
      {
        error:
          "This Inspector could not establish its machine identity, so a " +
          "machine-scoped consent grant cannot be minted: " +
          `${error instanceof Error ? error.message : String(error)}`,
      },
      500,
    );
  }

  // Register (or confirm) this installation's key with the backend. Done before
  // the grant is minted: a consent that promised local execution while the
  // machine had no registered key would mint a capability that no turn could
  // ever obtain a lease for.
  const bearer = (c.req.header("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  let keyId: string | null = null;
  if (bearer.length > 0) {
    const identity = await readLocalInstanceIdentity();
    const registration = await registerLocalInstance({
      machineId: identity.machineId,
      publicKey: identity.publicKey,
      bearer,
    });
    if (!registration.ok) {
      return c.json(
        {
          error:
            "This installation could not be registered for local execution: " +
            registration.error,
        },
        registration.status >= 400 && registration.status < 500 ? 403 : 502,
      );
    }
    keyId = registration.keyId;
    setRegisteredKeyId(keyId);
  }

  const binding: HarnessGrantBinding = {
    userId,
    machineId,
    projectId,
    workspaceGrantId,
    harnessId: "claude-code",
    targetKind: "local-native",
    runtimeId: resolved.runtime.runtimeId,
    permissionProfile: "workspace-edits",
    policyVersion: LOCAL_HARNESS_POLICY_VERSION,
  };
  const granted = await grantLocalHarnessConsent(binding);

  return c.json({
    grantId: granted.grantId,
    // The plaintext capability, returned exactly once. Only its hash is stored.
    token: granted.token,
    expiresAt: granted.expiresAt,
    // The ids a turn will send back, so the client never has to re-derive them.
    target: {
      kind: "local-native",
      harnessId: "claude-code",
      machineId,
      workspaceGrantId,
      runtimeId: resolved.runtime.runtimeId,
      permissionProfile: "workspace-edits",
      policyVersion: LOCAL_HARNESS_POLICY_VERSION,
    },
    workspaceDisplayRoot: displayRoot(workspace.canonicalPath),
    runtime: {
      runtimeId: resolved.runtime.runtimeId,
      adapterVersion: resolved.runtime.adapterVersion,
      digest: resolved.runtime.digest,
      packVersion: runtimeStatus.packVersion,
    },
    keyId,
  });
});

/**
 * `POST /consent/revoke` — "Forget & re-authorize".
 *
 * Scoped to a presented grant id when one is supplied, so a delayed revoke from
 * an old tab cannot sever a newer grant; unconditional otherwise, which is what
 * the user means when they click the button with nothing in flight.
 */
localHarness.post("/consent/revoke", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    grantId?: unknown;
  } | null;
  const grantId = typeof body?.grantId === "string" ? body.grantId : null;
  const removed = await revokeLocalHarnessGrants(
    grantId ? { grantId } : undefined,
  );
  return c.json({ ok: true, removed });
});

/**
 * `POST /stop-all` — the local brake.
 *
 * Stops every supervised session this process owns and revokes their gateways.
 * Separate from consent revocation because they answer different questions:
 * this one is "stop what is running now", and consent revocation is "do not
 * start anything else".
 */
localHarness.post("/stop-all", async (c) => {
  const result = await stopAllLocalHarnessSessions();
  return c.json(result);
});

export default localHarness;
