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
  expectedPackFor,
  manifestWithExpectedBundleDigest,
  readRuntimeInstallStatus,
  readVerifiedRuntimeStatus,
  runtimeInstallRoot,
  startRuntimeInstall,
} from "../../utils/harness/local/runtime-install.js";
import { resolveSuggestedWorkspace } from "../../utils/harness/local/suggested-workspace.js";
import { isComputersDataPlaneConfigured } from "../../utils/computers/control-plane-client.js";
import { resolveManagedBundle } from "../../utils/harness/local/runtime-identity.js";
import { supportsOwnershipProof } from "../../utils/harness/local/process-identity.js";
import {
  currentLocalPlatform,
  localPackTarget,
  LOCAL_HARNESS_POLICY_VERSION,
  type LocalPermissionProfile,
} from "../../utils/harness/local/targets.js";
import {
  contextCredentialClass,
  resolveLocalHarnessActor,
} from "../../utils/harness/local/acting-user.js";
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
 * The signed-in user consent binds to.
 *
 * Deliberately NOT "whichever context field the middleware happened to set".
 * `acting-user.ts` names the one accepted credential class and the canonical
 * id, and `/api/mcp/chat-v2` asks the same module when it verifies a turn
 * against the binding this mints — so the two can no longer derive different
 * ids for the same request, and no class can mint a grant that no turn could
 * ever spend.
 */
function resolveConsentActor(c: {
  get: (key: string) => unknown;
  req: { header: (name: string) => string | undefined };
}) {
  return resolveLocalHarnessActor({
    authorizationHeader: c.req.header("authorization"),
    contextCredential: contextCredentialClass(c),
  });
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
      manifest: manifestWithExpectedBundleDigest(
        manifest,
        "claude-code",
        localPackTarget(),
      ),
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

  // The pack this build EXPECTS, whether or not one is installed. Without it
  // the dialog cannot name the runtime a user is about to approve before the
  // download, and "approve a named runtime, then download it" is the whole
  // shape of the consent flow.
  const packTarget = localPackTarget(process.platform, process.arch);
  const expectedPack =
    packTarget === null ? null : expectedPackFor("claude-code", packTarget);

  // Whether a CLOUD execution target is infrastructurally available on this
  // server. Deliberately narrow: it says the computers data plane is
  // configured, NOT that any given model or host is eligible to use it — the
  // per-turn preflight (`checkHarnessRuntimeAvailable`) still decides that and
  // is untouched. The client needs this one bit to know whether "This machine"
  // is a CHOICE or simply what this Inspector is; a normal npx or Electron
  // install has no data plane, so there is no picker to show.
  const hostedAvailable = isComputersDataPlaneConfigured();

  const suggestedWorkspace = await resolveSuggestedWorkspace({ displayRoot });

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
    hostedAvailable,
    expectedPack,
    // Display only, and only when this server was deliberately told where the
    // user launched from. Never inferred from `process.cwd()`, which is the
    // installed package's own root, and never sent to telemetry.
    suggestedWorkspace:
      suggestedWorkspace === null
        ? null
        : { displayRoot: suggestedWorkspace.displayRoot },
  });
});

/**
 * `GET /runtime/status` — cheap enough to poll while an install runs.
 *
 * Reads; never writes, never downloads, never mints anything. A poll that
 * could start work would turn a reload or a remount into a 200 MB fetch
 * nobody asked for, which is the behaviour this whole flow is arranged to
 * avoid.
 *
 * `?verify=1` asks the more expensive question — is the installed tree still
 * the tree we verified? — which re-digests at most once per process per pack
 * through the verification cache. The polling client does not use it; the
 * pre-consent check does.
 */
localHarness.get("/runtime/status", async (c) => {
  const verify = c.req.query("verify") === "1";
  return c.json(
    verify
      ? await readVerifiedRuntimeStatus({ harnessId: "claude-code" })
      : await readRuntimeInstallStatus({ harnessId: "claude-code" }),
  );
});

/**
 * `POST /runtime/install` — the explicit "Install & allow" gesture.
 *
 * ── Why this returns before the work finishes ────────────────────────────
 * A pack is a ~200 MB download and several minutes of verification. Holding a
 * request open for that is a request that dies to a proxy timeout, a laptop
 * sleeping, or a reload — and the client then has no way to tell "still
 * downloading" from "the request was lost". So this ACKNOWLEDGES and the
 * client polls, which is the ordinary asynchronous request-reply shape:
 *
 *   202 + `Location: …/runtime/status` + `Retry-After` — work is running,
 *         whether this call started it or joined one already in flight (in
 *         this process or another Inspector);
 *   200 — a verified runtime is already installed and nothing was downloaded;
 *   409 — the approved pack is not the pack this build now expects;
 *   400 — this machine has no pack to install.
 *
 * The client AWAITS this acknowledgement. It is not fire-and-forget: a POST
 * whose response nobody reads is a POST whose refusal nobody sees.
 */
localHarness.post("/runtime/install", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    expectedPack?: { packVersion?: unknown; treeDigest?: unknown };
  } | null;
  // The pack the CLIENT approved, compared against what this build expects
  // before a byte moves. A server that updated between the dialog opening and
  // the click would otherwise download a runtime whose identity the user was
  // never shown — and consent binds to that identity.
  const approved =
    typeof body?.expectedPack?.packVersion === "string" &&
    typeof body?.expectedPack?.treeDigest === "string"
      ? {
          packVersion: body.expectedPack.packVersion,
          treeDigest: body.expectedPack.treeDigest,
        }
      : undefined;

  const started = await startRuntimeInstall({
    harnessId: "claude-code",
    ...(approved ? { expectedPack: approved } : {}),
  });

  if (started.kind === "ready") {
    return c.json({ state: "ready", status: started.status }, 200);
  }
  if (started.kind === "refused") {
    logger.warn("[local-harness] runtime install refused", {
      reason: started.reason,
    });
    return c.json(
      {
        error: started.reason,
        status: started.status,
        // A pack mismatch is a CONTEXT change the client recovers from by
        // re-approving, not a malformed request it should retry as-is.
        reason:
          started.status.state === "failed" &&
          started.status.reason === "verification"
            ? "expected-pack-changed"
            : "unsupported",
      },
      started.status.state === "failed" ? 409 : 400,
    );
  }

  c.header("Location", "/api/mcp/local-harness/runtime/status");
  // Seconds. Long enough not to hammer a machine that is also downloading
  // 200 MB, short enough that a percentage looks live.
  c.header("Retry-After", "1");
  return c.json(
    {
      state: started.kind,
      ...(started.attemptId ? { attemptId: started.attemptId } : {}),
      status: started.status,
      statusUrl: "/api/mcp/local-harness/runtime/status",
      retryAfterSeconds: 1,
    },
    202,
  );
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
    useSuggested?: unknown;
  } | null;
  const path = typeof body?.path === "string" ? body.path.trim() : "";
  const useSuggested = body?.useSuggested === true;

  // Exactly one of the two. A request naming both is ambiguous about which the
  // user actually chose, and picking one for them is the kind of guess that
  // ends with an agent working in a folder nobody selected.
  if (useSuggested && path.length > 0) {
    return c.json(
      {
        error:
          "send either a path or useSuggested, not both — they name different " +
          "folders and this request does not say which one you meant",
      },
      400,
    );
  }
  if (!useSuggested && path.length === 0) {
    return c.json({ error: "A workspace path is required" }, 400);
  }

  let selected = path;
  if (useSuggested) {
    // RE-RESOLVED here rather than trusting the display string the client was
    // handed a moment ago: the client never sees the absolute path (by design),
    // so "the suggested folder" has to mean whatever this server resolves it to
    // now — and it revalidates, because a directory can be replaced between
    // being offered and being accepted.
    const suggested = await resolveSuggestedWorkspace({ displayRoot });
    if (suggested === null) {
      return c.json(
        {
          error:
            "this Inspector has no suggested workspace to register — it was " +
            "not launched from a project directory. Choose a folder instead.",
        },
        400,
      );
    }
    selected = suggested.canonicalPath;
  }

  const registered = await registerWorkspaceGrant(selected);
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
    expect?: {
      machineId?: unknown;
      packVersion?: unknown;
      treeDigest?: unknown;
      permissionProfile?: unknown;
      policyVersion?: unknown;
    };
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
  // What the CLIENT believes it was approved against, for comparison only.
  // Every one of these is re-derived below from what this server can prove;
  // none of them is used as the value that gets bound. A caller's expectation
  // is a question ("is this still true?"), never an authority.
  const expected = body?.expect ?? {};
  // The signed-in identity, verified here rather than taken from the request
  // body: consent binds to a user, and a user the caller names is a user the
  // caller chose. The refusal carries the credential's own status so a
  // deployment with no AuthKit reads as the operator problem it is (503)
  // rather than as a sign-in the user can retry.
  const actor = await resolveConsentActor(c);
  if (!actor.ok) {
    return c.json({ error: actor.message, reason: actor.reason }, actor.status);
  }
  const userId = actor.actor.userId;

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
    manifest: manifestWithExpectedBundleDigest(
      LOCAL_HARNESS_MANIFEST["claude-code"],
      "claude-code",
      localPackTarget(),
    ),
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

  // ── The approved context, compared before anything is minted ─────────────
  //
  // The dialog shows a machine, a runtime version and digest, a permission
  // profile and a policy version, and the user clicks Allow against THAT. The
  // grant is minted later — after a download on a cold install, after a
  // round trip on a warm one — and any of them can have changed in between: a
  // server update expecting a new pack, a policy bump, a machine identity
  // re-minted after a state reset.
  //
  // So the client sends back what it was shown, and this compares it against
  // the authoritative values resolved above. A mismatch is a typed 409 and no
  // grant, because minting one would bind the user's click to terms they were
  // never shown — which is exactly the substitution the whole binding exists
  // to prevent.
  const authoritative = {
    machineId,
    packVersion: runtimeStatus.packVersion,
    treeDigest: runtimeStatus.digest,
    permissionProfile: "workspace-edits" satisfies LocalPermissionProfile,
    policyVersion: LOCAL_HARNESS_POLICY_VERSION,
  };
  const changed = (
    Object.keys(authoritative) as (keyof typeof authoritative)[]
  ).filter((field) => {
    const claimed = (expected as Record<string, unknown>)[field];
    // An omitted expectation is not a mismatch: a caller that never captured
    // one is asking for the terms rather than confirming them, which is what
    // the response body is for.
    if (claimed === undefined) return false;
    return claimed !== authoritative[field];
  });
  if (changed.length > 0) {
    return c.json(
      {
        error:
          "what you approved is not what this machine would run now " +
          `(${changed.join(", ")} changed). Review and authorize again.`,
        reason: "consent-context-changed",
        changed,
        // The CURRENT terms, so the dialog can re-render without another
        // round trip. No secret and no path among them.
        current: {
          machineId: authoritative.machineId,
          packVersion: authoritative.packVersion,
          treeDigest: authoritative.treeDigest,
          permissionProfile: authoritative.permissionProfile,
          policyVersion: authoritative.policyVersion,
        },
      },
      409,
    );
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
