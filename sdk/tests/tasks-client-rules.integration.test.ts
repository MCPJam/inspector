/**
 * The client rule `tasks-declaration-hygiene` used to grade as a server check.
 *
 * That check read only the requests MCPJam itself sent, so a server could not
 * fail it, and it scored a point for every server. Its rule binds the client:
 *   - 2025-11-25 tasks (`basic/utilities/tasks`, Tool-Level Negotiation): the
 *     task opt-in is `params.task` on `tools/call`, and only a server that
 *     declared `tasks.requests.tools.call` may get it.
 *   - ext-tasks 2026-07-28 (`tasks.md`, Capability Negotiation): the client
 *     declares the extension per request, under
 *     `_meta["io.modelcontextprotocol/clientCapabilities"].extensions`, and
 *     never signals task preference on the request itself.
 *   - SEP-2663: the extension is treated as absent on 2025-11-25.
 *
 * So here it runs in CI, against the real client: the whole Tasks suite runs
 * against each fixture, every request the fixture received is checked with
 * the same helper the removed check used, and each wire must also show the
 * form it does use, so the assertion is never vacuous.
 */

import { afterEach, describe, expect, it } from "vitest";
import { findDeclarationViolations } from "../src/tasks-conformance/metadata.js";
import { MCPTasksConformanceTest } from "../src/tasks-conformance/index.js";
import {
  EXTENSION_PROTOCOL_VERSION,
  TASK_TOOL_NAME,
  serveExtensionTasksFixture,
} from "./support/extension-tasks-fixture.js";
import {
  LEGACY_TASK_TOOL_NAME,
  serveLegacyTasksFixture,
} from "./support/legacy-tasks-fixture.js";

const EXT_ID = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

interface Received {
  method: string;
  params: Record<string, unknown> | undefined;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function asMessages(received: Received[]) {
  return received.map(({ method, params }) => ({ method, params }));
}

function carriesTaskParam(request: Received) {
  return request.params?.task !== undefined;
}

function declaresExtension(request: Received) {
  const meta = request.params?._meta as Record<string, unknown> | undefined;
  const declared = meta?.[CLIENT_CAPABILITIES] as
    { extensions?: Record<string, unknown> } | undefined;
  return declared?.extensions !== undefined && EXT_ID in declared.extensions;
}

async function runSuite(url: string, version: string, toolName: string) {
  return new MCPTasksConformanceTest({
    url,
    mcpProtocolVersion: version,
    timeout: 10_000,
    toolName,
    pollTimeoutMs: 5_000,
    __suppressTelemetry: true,
  } as never).run();
}

describe("what MCPJam sends on each tasks wire (the whole suite's traffic)", () => {
  it("2025-11-25 legacy wire: params.task on tools/call, never the extension declaration", async () => {
    const fixture = await serveLegacyTasksFixture();
    closers.push(fixture.close);

    const result = await runSuite(
      fixture.url,
      "2025-11-25",
      LEGACY_TASK_TOOL_NAME
    );

    expect(result.discovery.wire).toBe("legacy");
    expect(
      findDeclarationViolations("legacy", asMessages(fixture.received))
    ).toEqual([]);
    expect(fixture.received.filter(declaresExtension)).toEqual([]);
    // Not vacuous: the suite did send a task-augmented call.
    expect(
      fixture.received.filter(
        (r) => r.method === "tools/call" && carriesTaskParam(r)
      )
    ).not.toHaveLength(0);
    // And params.task went nowhere but tools/call.
    expect(
      fixture.received.filter(
        (r) => r.method !== "tools/call" && carriesTaskParam(r)
      )
    ).toEqual([]);
  });

  it("2026-07-28 extension wire: the extension declaration, never params.task", async () => {
    const fixture = await serveExtensionTasksFixture();
    closers.push(fixture.close);

    const result = await runSuite(
      fixture.url,
      EXTENSION_PROTOCOL_VERSION,
      TASK_TOOL_NAME
    );

    expect(result.discovery.wire).toBe("extension");
    expect(
      findDeclarationViolations("extension", asMessages(fixture.received))
    ).toEqual([]);
    expect(fixture.received.filter(carriesTaskParam)).toEqual([]);
    // Not vacuous: the suite did declare the extension on its requests.
    expect(fixture.received.filter(declaresExtension)).not.toHaveLength(0);
  });

  it("2025-11-25 server that declares no tasks: neither form is sent", async () => {
    const fixture = await serveLegacyTasksFixture({ tasksCapability: {} });
    closers.push(fixture.close);

    const result = await runSuite(
      fixture.url,
      "2025-11-25",
      LEGACY_TASK_TOOL_NAME
    );

    expect(result.discovery.wire).toBe("none");
    expect(
      findDeclarationViolations("none", asMessages(fixture.received))
    ).toEqual([]);
    expect(fixture.received.filter(carriesTaskParam)).toEqual([]);
    expect(fixture.received.filter(declaresExtension)).toEqual([]);
    expect(fixture.received).not.toHaveLength(0);
  });

  it("2026-07-28 server that does not declare the extension: neither form is sent", async () => {
    const fixture = await serveExtensionTasksFixture({
      advertiseTasksExtension: false,
    });
    closers.push(fixture.close);

    const result = await runSuite(
      fixture.url,
      EXTENSION_PROTOCOL_VERSION,
      TASK_TOOL_NAME
    );

    expect(result.discovery.wire).toBe("none");
    expect(
      findDeclarationViolations("none", asMessages(fixture.received))
    ).toEqual([]);
    expect(fixture.received.filter(carriesTaskParam)).toEqual([]);
    expect(fixture.received.filter(declaresExtension)).toEqual([]);
    expect(fixture.received).not.toHaveLength(0);
  });
});
