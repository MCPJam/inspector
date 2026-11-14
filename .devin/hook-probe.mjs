#!/usr/bin/env node
/**
 * Temporary probe for `.devin/hooks.v1.json`. Devin documents repo hooks for
 * local sessions (CLI, Desktop) and says nothing about cloud sessions; this
 * records whether they fire there, and with which tool names, so a real hook
 * can be written against facts. Delete both files once that is known.
 *
 * Appends one JSON line per event to /tmp/devin-hook-probe.log. Records env
 * var names only, never values. Always exits 0.
 */
import { appendFileSync, readFileSync } from "node:fs";

const LOG = "/tmp/devin-hook-probe.log";

function readEvent() {
  const raw = readFileSync(0, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    return { unparsed: raw.slice(0, 200), parseError: String(error) };
  }
}

const event = readEvent();
appendFileSync(
  LOG,
  JSON.stringify({
    at: new Date().toISOString(),
    event: event.hook_event_name,
    tool: event.tool_name,
    cwd: process.cwd(),
    keys: Object.keys(event),
    env: Object.keys(process.env).filter((name) =>
      /DEVIN|CLAUDE|WINDSURF|COGNITION/.test(name),
    ),
  }) + "\n",
);

if (event.hook_event_name === "SessionStart") {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "The repo hook probe (.devin/hooks.v1.json) ran at session start. " +
          `If asked about hooks, report the contents of ${LOG}.`,
      },
    }),
  );
}
