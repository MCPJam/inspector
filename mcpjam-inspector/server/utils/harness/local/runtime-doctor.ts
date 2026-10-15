/**
 * `mcpjam-inspector harness doctor` and `harness repair`: what a support
 * engineer — or an IT admin with no engineer — needs to see and do about a
 * machine's local runtimes, without reading logs.
 *
 * The report answers, per harness: which pack this Inspector runs and why
 * (desired, permitted previous, nothing), what the desired and previous packs
 * are on disk (installed, verified, healthy, revoked), what the last install
 * attempt did and at which stage it stopped, and what to do about it. Machine
 * facts beside it: the runtime root, free disk, the proxy and CA settings the
 * installer will use, the update policy.
 *
 * `--export <file>` writes the same report REDACTED for sharing: the home
 * directory becomes `~`, proxy credentials are removed, and anything shaped
 * like a token is masked. Nothing in the report is a credential by
 * construction; the redaction is the second line, for messages that quote
 * paths and URLs.
 */
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { LOCAL_HARNESS_MANIFEST } from "./compatibility.js";
import { resolveLocalCompatibility } from "./compatibility.js";
import { describeInstallerNetwork } from "./runtime-fetch.js";
import { readRuntimeHealth, type RuntimeHealthRecord } from "./runtime-health.js";
import {
  expectedPackFor,
  isPackInstalled,
  packVersionRoot,
  permittedPackFor,
  readDesiredRuntimeStatus,
  readRuntimeInstallStatus,
  readVerifiedRuntimeStatus,
  type RuntimeInstallStatus,
} from "./runtime-install.js";
import { readRuntimeOperation, type RuntimeOperationRecord } from "./runtime-lifecycle.js";
import { readCachedRevocations, revocationFor, revocationsUrl } from "./runtime-revocation.js";
import { runtimeInstallRoot } from "./runtime-root.js";
import { readLocalRuntimeUpdatePolicy, type ResolvedUpdatePolicy } from "./runtime-update-policy.js";
import {
  currentLocalPlatform,
  localPackTarget,
  SUPPORTED_LOCAL_HARNESS_IDS,
  type SupportedLocalHarnessId,
} from "./targets.js";

export const DOCTOR_SCHEMA = "mcpjam.local-harness-doctor/1";

export interface DoctorPackView {
  packVersion: string;
  treeDigest: string;
  installed: boolean;
  revoked: string | null;
  health: "healthy" | "unhealthy" | "unprobed" | "absent";
  unhealthyReason?: string;
  launchFailures?: number;
}

export interface DoctorHarnessReport {
  harnessId: SupportedLocalHarnessId;
  /** What a session would run now: the selection. */
  selected: RuntimeInstallStatus;
  /** The desired pack's own state, verified when the report was asked to. */
  desiredStatus: RuntimeInstallStatus;
  desired: DoctorPackView | null;
  permitted: DoctorPackView | null;
  compatibility: { ok: true } | { ok: false; status: string; message: string };
  lastAttempt: Pick<RuntimeOperationRecord, "state" | "packVersion" | "stage" | "reason" | "message" | "trigger" | "updatedAt"> | null;
  /** Commands that would help, most useful first. Empty when nothing is wrong. */
  repairs: string[];
}

export interface DoctorReport {
  schema: typeof DOCTOR_SCHEMA;
  generatedAt: string;
  machine: { os: string; arch: string; target: string | null };
  runtimeRoot: string;
  freeBytes: number | null;
  updatePolicy: ResolvedUpdatePolicy;
  network: ReturnType<typeof describeInstallerNetwork>;
  revocations: { url: string; sequence: number | null; revoked: number };
  harnesses: DoctorHarnessReport[];
}

async function packView(
  harnessId: SupportedLocalHarnessId,
  pack: { packVersion: string; treeDigest: string } | null,
  installed: boolean,
  revocations: Awaited<ReturnType<typeof readCachedRevocations>>,
): Promise<DoctorPackView | null> {
  if (pack === null) return null;
  const target = localPackTarget();
  const record: RuntimeHealthRecord | null =
    target === null ? null : await readRuntimeHealth(packVersionRoot(harnessId, pack.packVersion, target));
  const sameBytes = record !== null && record.treeDigest === pack.treeDigest;
  return {
    ...pack,
    installed,
    revoked: revocationFor(revocations, harnessId, pack.treeDigest)?.reason ?? null,
    health: !installed
      ? "absent"
      : sameBytes && record!.unhealthy
        ? "unhealthy"
        : sameBytes && record!.probe
          ? "healthy"
          : "unprobed",
    ...(sameBytes && record!.unhealthy ? { unhealthyReason: record!.unhealthy.reason } : {}),
    ...(sameBytes ? { launchFailures: record!.launchFailures.length } : {}),
  };
}

/** What would help, from what the report found. Pure. */
export function suggestRepairs(input: {
  harnessId: SupportedLocalHarnessId;
  selected: RuntimeInstallStatus;
  desiredStatus: RuntimeInstallStatus;
  desired: DoctorPackView | null;
  policy: ResolvedUpdatePolicy["policy"];
  proxyConfigured: boolean;
}): string[] {
  const flag = input.harnessId === "claude-code" ? "" : ` --harness ${input.harnessId}`;
  const install = `mcpjam-inspector harness install${flag}`;
  const repair = `mcpjam-inspector harness repair${flag}`;
  const offline = `mcpjam-inspector harness install${flag} --from <pack>.tar.gz   (no network; keep the .manifest.json and .sig beside it)`;
  const out: string[] = [];
  const d = input.desiredStatus;
  if (d.state === "unsupported-platform") return [];
  if (input.desired?.revoked) {
    out.push(`Update the Inspector: MCPJam withdrew the ${input.harnessId} runtime ${input.desired.packVersion} (${input.desired.revoked}).`);
  }
  if (d.state === "corrupt") out.push(repair);
  if (d.state === "ready" && input.desired?.health === "unhealthy") out.push(repair);
  if (d.state === "failed") {
    if (d.stage === "disk-space" || d.reason === "disk") out.push(`Free disk space under the runtime root, then: ${install}`);
    else if (d.reason === "network") {
      out.push(
        input.proxyConfigured
          ? "Check HTTPS_PROXY / NO_PROXY, and NODE_EXTRA_CA_CERTS if the proxy inspects TLS."
          : "If this network needs a proxy, set HTTPS_PROXY (and NODE_EXTRA_CA_CERTS for a TLS-inspecting proxy).",
      );
      out.push(install);
      out.push(offline);
    } else out.push(install);
  }
  if (d.state === "absent" || d.state === "interrupted") {
    out.push(install);
    if (input.policy === "manual") out.push(offline);
  }
  if (input.selected.state === "ready" && input.selected.role === "permitted" && d.state === "absent" && input.policy === "manual") {
    out.push("Updates are manual on this machine: the previous runtime keeps working until an administrator installs the new one.");
  }
  return [...new Set(out)];
}

/** Build the report. `verify` re-digests the desired pack (slower, definitive). */
export async function buildDoctorReport(options: {
  harnessIds?: readonly SupportedLocalHarnessId[];
  verify?: boolean;
} = {}): Promise<DoctorReport> {
  const target = localPackTarget();
  const platform = currentLocalPlatform(process.platform);
  const runtimeRoot = runtimeInstallRoot();
  const updatePolicy = await readLocalRuntimeUpdatePolicy();
  const network = describeInstallerNetwork();
  const revocations = await readCachedRevocations();
  let freeBytes: number | null = null;
  try {
    const { statfs } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const info = await statfs(existsSync(runtimeRoot) ? runtimeRoot : homedir());
    freeBytes = Number(info.bavail) * Number(info.bsize);
  } catch {
    freeBytes = null;
  }

  const harnesses: DoctorHarnessReport[] = [];
  for (const harnessId of options.harnessIds ?? SUPPORTED_LOCAL_HARNESS_IDS) {
    const selected = await readRuntimeInstallStatus({ harnessId });
    const desiredStatus = options.verify
      ? await readVerifiedRuntimeStatus({ harnessId, desiredOnly: true })
      : await readDesiredRuntimeStatus({ harnessId });
    const desiredPack = target === null ? null : expectedPackFor(harnessId, target);
    const permittedPack = target === null ? null : permittedPackFor(harnessId, target);
    const permittedInstalled = permittedPack !== null && (await isPackInstalled(harnessId, permittedPack, target));
    const desired = await packView(harnessId, desiredPack, desiredStatus.state === "ready", revocations);
    const permitted = await packView(harnessId, permittedPack, permittedInstalled, revocations);
    const manifest = LOCAL_HARNESS_MANIFEST[harnessId];
    const compatibility =
      platform === null
        ? { ok: false as const, status: "platform-not-supported", message: `${process.platform} has no local harness` }
        : (() => {
            const result = resolveLocalCompatibility(
              {
                harnessId,
                platform,
                targetKind: "local-native",
                permissionProfile: "workspace-edits",
                packTarget: target,
                installedAdapterVersion: manifest.adapterVersion,
              },
              LOCAL_HARNESS_MANIFEST,
            );
            return result.ok ? { ok: true as const } : { ok: false as const, status: result.status, message: result.message };
          })();
    const record =
      desiredPack === null || target === null
        ? null
        : await readRuntimeOperation({ runtimeRoot, harnessId, target, ...desiredPack });
    harnesses.push({
      harnessId,
      selected,
      desiredStatus,
      desired,
      permitted,
      compatibility,
      lastAttempt:
        record === null
          ? null
          : {
              state: record.state,
              packVersion: record.packVersion,
              ...(record.stage ? { stage: record.stage } : {}),
              ...(record.reason ? { reason: record.reason } : {}),
              ...(record.message ? { message: record.message } : {}),
              ...(record.trigger ? { trigger: record.trigger } : {}),
              updatedAt: record.updatedAt,
            },
      repairs: suggestRepairs({
        harnessId,
        selected,
        desiredStatus,
        desired,
        policy: updatePolicy.policy,
        proxyConfigured: network.proxy !== null,
      }),
    });
  }

  return {
    schema: DOCTOR_SCHEMA,
    generatedAt: new Date().toISOString(),
    machine: { os: osPlatform(), arch: osArch(), target },
    runtimeRoot,
    freeBytes,
    updatePolicy,
    network,
    revocations: { url: revocationsUrl(), sequence: revocations?.sequence ?? null, revoked: revocations?.revoked.length ?? 0 },
    harnesses,
  };
}

const TOKEN_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, // API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /\b(?:token|secret|password|apikey|api_key|key)=([^&\s"']+)/gi,
];

/** The report, fit to attach to a ticket: no home path, no credential. */
export function redactDoctorReport(report: DoctorReport, home: string = homedir()): DoctorReport {
  let text = JSON.stringify(report);
  if (home && home !== "/") {
    const escaped = JSON.stringify(home).slice(1, -1); // as it appears inside JSON strings
    text = text.split(escaped).join("~");
  }
  text = text.replace(/:\/\/[^/@"\s]+@/g, "://***@");
  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, (match) => {
      const eq = match.indexOf("=");
      return eq > 0 && !/^Bearer/i.test(match) ? `${match.slice(0, eq + 1)}[redacted]` : "[redacted]";
    });
  }
  return JSON.parse(text) as DoctorReport;
}

/** A human summary of the report, for the terminal. */
export function renderDoctorReport(report: DoctorReport): string {
  const mb = (bytes: number | null) => (bytes === null ? "unknown" : `${Math.floor(bytes / 1024 / 1024)} MB`);
  const lines: string[] = [];
  lines.push(`Machine: ${report.machine.os}-${report.machine.arch} (pack target ${report.machine.target ?? "none"})`);
  lines.push(`Runtime root: ${report.runtimeRoot} — ${mb(report.freeBytes)} free`);
  lines.push(
    `Updates: ${report.updatePolicy.policy}${report.updatePolicy.source ? ` (from ${report.updatePolicy.source})` : " (default)"}` +
      (report.updatePolicy.problem ? ` — ${report.updatePolicy.problem}` : ""),
  );
  lines.push(
    `Network: proxy ${report.network.proxy ?? "none"}` +
      (report.network.noProxy ? `, NO_PROXY ${report.network.noProxy}` : "") +
      `, extra CA ${report.network.extraCaCerts ?? "none"}`,
  );
  lines.push(`Revocations: list ${report.revocations.sequence ?? "not cached"}, ${report.revocations.revoked} revoked`);
  for (const h of report.harnesses) {
    lines.push("");
    lines.push(`${h.harnessId}:`);
    const s = h.selected;
    lines.push(
      s.state === "ready"
        ? `  runs: ${s.packVersion} (${s.role ?? "desired"}${s.health ? `, ${s.health}` : ""}) ${s.digest.slice(0, 19)}…`
        : `  runs: nothing (${s.state}${"message" in s && s.message ? `: ${s.message}` : ""})`,
    );
    const pack = (label: string, p: DoctorPackView | null) =>
      p === null
        ? `  ${label}: none`
        : `  ${label}: ${p.packVersion} ${p.treeDigest.slice(0, 19)}… — ${p.installed ? "installed" : "not installed"}, ${p.health}` +
          (p.revoked ? `, REVOKED (${p.revoked})` : "") +
          (p.unhealthyReason ? ` — ${p.unhealthyReason}` : "");
    lines.push(pack("desired", h.desired));
    lines.push(pack("previous", h.permitted));
    lines.push(`  compatibility: ${h.compatibility.ok ? "ok" : `${h.compatibility.status} — ${h.compatibility.message}`}`);
    if (h.lastAttempt) {
      lines.push(
        `  last install: ${h.lastAttempt.state}` +
          (h.lastAttempt.stage ? ` at ${h.lastAttempt.stage}` : "") +
          (h.lastAttempt.trigger ? ` (${h.lastAttempt.trigger})` : "") +
          (h.lastAttempt.message && h.lastAttempt.state !== "ready" ? ` — ${h.lastAttempt.message}` : ""),
      );
    }
    for (const repair of h.repairs) lines.push(`  → ${repair}`);
  }
  return lines.join("\n");
}
