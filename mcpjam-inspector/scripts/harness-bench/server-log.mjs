// Reads what an Inspector instance's log gained during one turn and parses the
// harness lines: `[harness][timing]`, `[harness][trace]` (MCPJAM_HARNESS_TRACE=1)
// and the warnings that name a fallback.
import { openSync, readSync, fstatSync, closeSync } from "node:fs";

export function logSize(path) {
  const fd = openSync(path, "r");
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

export function readLogSince(path, offset) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { text: "", offset: size };
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    return { text: buffer.toString("utf8"), offset: size };
  } finally {
    closeSync(fd);
  }
}

function fieldsOf(text) {
  const fields = {};
  for (const match of text.matchAll(/(\w+)=(\S+)/g)) {
    const [, key, raw] = match;
    const value = raw.replace(/ms$/, "");
    fields[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : raw;
  }
  return fields;
}

const FALLBACK = /warm bridge unavailable|resuming from disk|fell back|fallback|using normal startup|reset|replaced|refused|TURN_FAILED|harnessTurn=failed|turn=failed/i;

export function parseHarnessLog(text) {
  const result = { timing: null, trace: [], turnEvents: [], warnings: [], dispatch: null };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^\[server\]\s*/, "");
    if (line.startsWith("[harness][timing] ")) {
      result.timing = fieldsOf(line.slice("[harness][timing] ".length));
    } else if (line.startsWith("[harness][trace] ")) {
      const body = line.slice("[harness][trace] ".length);
      const match = /^t=(\d+) (\S+)(.*)$/.exec(body);
      if (!match) continue;
      const [, t, name, rest] = match;
      const entry = { t: Number(t), name };
      const dur = /durMs=(\d+)/.exec(rest);
      if (dur) entry.durMs = Number(dur[1]);
      if (name === "turn.event") Object.assign(entry, fieldsOf(rest));
      else entry.detail = rest.replace(/durMs=\d+\s*/, "").trim().slice(0, 160);
      result.trace.push(entry);
      if (name === "turn.event") result.turnEvents.push(entry);
    } else if (line.startsWith("[harness][dispatch] ")) {
      result.dispatch = fieldsOf(line);
    } else if (line.startsWith("[harness]") && FALLBACK.test(line)) {
      result.warnings.push(line.slice(0, 240));
    }
  }
  return result;
}
