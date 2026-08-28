#!/usr/bin/env node
/**
 * Apply the checked-in Axiom monitor definitions.
 *
 * The JSON under ./monitors is the source of truth. This script is a thin,
 * idempotent reconciler: it never invents a monitor, never edits one it does
 * not own, and never deletes anything unless told exactly what to delete.
 *
 * Ownership is claimed by a marker line appended to the monitor description
 * (MANAGED_MARKER below). A monitor in Axiom that shares a name with a
 * definition but carries no marker is reported as a conflict and left alone —
 * adopting it silently would let this script clobber hand-authored monitors.
 *
 *   node ops/axiom-monitors/apply.mjs                 # plan (default, read-only)
 *   node ops/axiom-monitors/apply.mjs --apply         # write
 *   node ops/axiom-monitors/apply.mjs --only <key>    # restrict to one definition
 *   node ops/axiom-monitors/apply.mjs --delete <key>  # delete exactly that managed monitor
 *
 * Env: AXIOM_TOKEN, AXIOM_ORG_ID, and one AXIOM_NOTIFIER_<KEY> per logical
 * notifier referenced by a definition. Notifier IDs are org-specific, so they
 * are resolved at apply time rather than committed.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONITOR_DIR = path.join(HERE, "monitors");
const API = "https://api.axiom.co";
const MANAGED_PREFIX = "[managed: ops/axiom-monitors/";
const managedMarker = (key) =>
  `${MANAGED_PREFIX}${key}.json — edit the file, not this monitor]`;

// Fields we send. Anything Axiom does not persist is reported after apply
// rather than assumed — this deployment's GET payload omits several of them,
// and a silently-dropped `resolvable` changes notification behaviour.
const MONITOR_FIELDS = [
  "type",
  "columnName",
  "operator",
  "threshold",
  "rangeMinutes",
  "intervalMinutes",
  "notifyByGroup",
  "alertOnNoData",
  "resolvable",
  "notifyEveryRun",
];

const REQUIRED_MONITOR_FIELDS = [
  "type",
  "columnName",
  "operator",
  "threshold",
  "rangeMinutes",
  "intervalMinutes",
  "resolvable",
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const shouldApply = flag("--apply");
const onlyKey = valueOf("--only");
const deleteKey = valueOf("--delete");

/** Never let a token reach stdout, even inside an error body. */
function redact(text) {
  const token = process.env.AXIOM_TOKEN;
  let out = String(text);
  if (token && token.length > 6) out = out.split(token).join("<redacted>");
  return out.replace(/xa(at|pt)-[0-9a-f-]{8,}/gi, "<redacted>");
}

function fail(message) {
  console.error(`✖ ${redact(message)}`);
  process.exit(1);
}

function requireEnv(name, why) {
  const v = process.env[name];
  if (!v) fail(`${name} is not set — ${why}`);
  return v;
}

const TOKEN = requireEnv("AXIOM_TOKEN", "needed to read or write monitors");
const ORG_ID = requireEnv("AXIOM_ORG_ID", "monitors are org-scoped");

async function axiom(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-Axiom-Org-Id": ORG_ID,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${route} → HTTP ${res.status}: ${redact(text)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** Logical notifier key → org-specific id, from the environment. */
function resolveNotifier(logicalKey) {
  const envName = `AXIOM_NOTIFIER_${logicalKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const id = process.env[envName];
  // A missing notifier must fail loudly: a monitor wired to nothing looks
  // healthy forever, which is the exact failure this whole effort exists to fix.
  if (!id) {
    fail(
      `notifier "${logicalKey}" is unresolved — set ${envName} to its Axiom notifier id`,
    );
  }
  return id;
}

function asText(value) {
  return Array.isArray(value) ? value.join("\n") : value;
}

function loadDefinitions() {
  let files;
  try {
    files = readdirSync(MONITOR_DIR).filter((f) => f.endsWith(".json")).sort();
  } catch {
    fail(`no monitor definitions found at ${MONITOR_DIR}`);
  }
  const defs = files.map((file) => {
    const full = path.join(MONITOR_DIR, file);
    let raw;
    try {
      raw = JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      fail(`${file} is not valid JSON: ${err.message}`);
    }
    for (const field of ["key", "name", "dataset", "notifier", "aplQuery", "description"]) {
      if (!raw[field]) fail(`${file} is missing required field "${field}"`);
    }
    if (raw.key !== path.basename(file, ".json")) {
      fail(`${file} declares key "${raw.key}" — key must equal the filename`);
    }
    if (!raw.monitor) fail(`${file} is missing the "monitor" block`);
    for (const field of REQUIRED_MONITOR_FIELDS) {
      if (raw.monitor[field] === undefined) {
        fail(`${file} monitor block is missing "${field}"`);
      }
    }
    const apl = asText(raw.aplQuery);
    if (!apl.includes(`['${raw.dataset}']`)) {
      fail(`${file} query does not read its declared dataset ['${raw.dataset}']`);
    }
    return { ...raw, aplQuery: apl, description: asText(raw.description), file };
  });
  const seen = new Set();
  for (const d of defs) {
    if (seen.has(d.name)) fail(`duplicate monitor name "${d.name}"`);
    seen.add(d.name);
  }
  return onlyKey ? defs.filter((d) => d.key === onlyKey) : defs;
}

/** Run the query read-only. A monitor whose APL does not compile is worthless. */
async function validateQuery(def) {
  const result = await axiom("POST", "/v1/datasets/_apl?format=tabular", {
    apl: def.aplQuery,
    startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    endTime: new Date().toISOString(),
  });
  const table = result?.tables?.[0];
  const columns = (table?.fields ?? []).map((f) => f.name);
  if (!columns.includes(def.monitor.columnName)) {
    throw new Error(
      `query does not produce columnName "${def.monitor.columnName}" (got: ${columns.join(", ") || "no columns"})`,
    );
  }
  const rows = table?.columns?.[0]?.length ?? 0;
  return { columns, rows };
}

function desiredBody(def) {
  const body = {
    name: def.name,
    description: `${def.description}\n\n${managedMarker(def.key)}`,
    aplQuery: def.aplQuery,
    notifierIds: [resolveNotifier(def.notifier)],
  };
  for (const field of MONITOR_FIELDS) {
    if (def.monitor[field] !== undefined) body[field] = def.monitor[field];
  }
  return body;
}

function diffFields(existing, desired) {
  const changed = [];
  for (const [k, v] of Object.entries(desired)) {
    // A key the API omits entirely from its response is not comparable: we
    // cannot know what it stored, so treating "absent" as "differs" reports a
    // change on every run. This deployment omits notifyByGroup / alertOnNoData
    // / notifyEveryRun when they equal its defaults, which made every re-run
    // print `update` and buried real drift in permanent noise — exactly what
    // the plan/diff step exists to surface.
    //
    // The cost is that drift in those specific fields is undetectable. That is
    // a property of the API, not a choice: it declines to tell us. Fields it
    // does echo — including `resolvable`, which governs repeat notifications —
    // still diff normally.
    if (!(k in existing)) continue;
    const before = existing[k];
    const same =
      Array.isArray(v) && Array.isArray(before)
        ? JSON.stringify(v) === JSON.stringify(before)
        : before === v;
    if (!same) changed.push(k);
  }
  return changed;
}

async function main() {
  const defs = loadDefinitions();
  if (defs.length === 0) fail(onlyKey ? `no definition with key "${onlyKey}"` : "no definitions");

  const remote = await axiom("GET", "/v2/monitors");
  const managedByKey = new Map();
  for (const m of remote) {
    const desc = m.description ?? "";
    const at = desc.indexOf(MANAGED_PREFIX);
    if (at === -1) continue;
    const key = desc.slice(at + MANAGED_PREFIX.length).split(".json")[0];
    managedByKey.set(key, m);
  }

  if (deleteKey) {
    const target = managedByKey.get(deleteKey);
    if (!target) fail(`no managed monitor with key "${deleteKey}" — refusing to guess`);
    console.log(`delete  ${target.name} (${target.id})`);
    if (!shouldApply) {
      console.log("\nplan only — re-run with --apply to delete");
      return;
    }
    await axiom("DELETE", `/v2/monitors/${target.id}`);
    console.log("deleted");
    return;
  }

  const planned = [];
  for (const def of defs) {
    let validation;
    try {
      validation = await validateQuery(def);
    } catch (err) {
      fail(`${def.file}: ${err.message}`);
    }
    const existing = managedByKey.get(def.key);
    const nameClash = remote.find(
      (m) => m.name === def.name && m.id !== existing?.id,
    );
    if (nameClash) {
      fail(
        `"${def.name}" already exists in Axiom (${nameClash.id}) without a managed marker. ` +
          `Refusing to adopt or overwrite an unmanaged monitor — rename one of them, or add the marker by hand to adopt it.`,
      );
    }
    const desired = desiredBody(def);
    const action = !existing
      ? "create"
      : diffFields(existing, desired).length
        ? "update"
        : "no-op";
    planned.push({ def, existing, desired, action, validation });
  }

  for (const p of planned) {
    const { def, existing, desired, action, validation } = p;
    const where = `${def.monitor.operator} ${def.monitor.threshold} over ${def.monitor.rangeMinutes}m every ${def.monitor.intervalMinutes}m`;
    console.log(`${action.padEnd(7)} ${def.name}`);
    console.log(`        tier=${def.tier ?? "?"} ${where} → notifier "${def.notifier}"`);
    console.log(`        query ok — ${validation.rows} row(s) in the last hour`);
    if (action === "update") {
      console.log(`        changes: ${diffFields(existing, desired).join(", ")}`);
    }
  }

  if (!shouldApply) {
    console.log("\nplan only — re-run with --apply to write. Unmanaged monitors are never touched.");
    return;
  }

  console.log("");
  for (const p of planned) {
    if (p.action === "no-op") continue;
    // v2 monitors take a FULL-object PUT: fields omitted from the body are
    // cleared, so updates merge onto the existing object rather than replacing it.
    const saved = p.existing
      ? await axiom("PUT", `/v2/monitors/${p.existing.id}`, {
          ...p.existing,
          ...p.desired,
        })
      : await axiom("POST", "/v2/monitors", p.desired);

    const dropped = Object.keys(p.desired).filter(
      (k) => saved?.[k] === undefined && p.desired[k] !== undefined,
    );
    console.log(`${p.action}d ${saved?.name} (${saved?.id})`);
    console.log(
      `        effective: ${saved?.operator} ${saved?.threshold} over ${saved?.rangeMinutes}m every ${saved?.intervalMinutes}m, notifiers=${JSON.stringify(saved?.notifierIds ?? [])}`,
    );
    if (dropped.length) {
      // Not fatal, but the operator must know: a field this deployment ignores
      // is a behaviour we documented in the plan and are not actually getting.
      console.log(
        `        ⚠ not persisted by this Axiom deployment: ${dropped.join(", ")}`,
      );
    }
  }
}

main().catch((err) => fail(err.stack ?? err.message));
