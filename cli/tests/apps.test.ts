import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatGptWidgetContent,
  buildMcpWidgetContent,
} from "../src/lib/apps.js";
import { CliError } from "../src/lib/output.js";

function createMockManager(contents: unknown[]) {
  return {
    readResource: async () => ({ contents }),
  } as any;
}

test("buildMcpWidgetContent injects runtime and reports mime validation", async () => {
  const manager = createMockManager([
    {
      mimeType: "text/html;profile=mcp-app",
      text: "<html><head></head><body><h1>Widget</h1></body></html>",
      _meta: {
        ui: {
          permissions: { geolocation: true },
          prefersBorder: true,
        },
      },
    },
  ]);

  const result = await buildMcpWidgetContent(manager, "srv", {
    resourceUri: "ui://widget",
    toolId: "tool-1",
    toolName: "draw",
    toolInput: { shape: "circle" },
    toolOutput: { ok: true },
  });

  assert.equal(result.mimeTypeValid, true);
  assert.equal(result.permissive, true);
  assert.equal(result.permissions?.geolocation, true);
  assert.equal(result.prefersBorder, true);
  assert.match(result.html, /openai-compat-config/);
});

test("buildMcpWidgetContent rejects invalid template protocol", async () => {
  const manager = createMockManager([]);

  await assert.rejects(
    () =>
      buildMcpWidgetContent(manager, "srv", {
        resourceUri: "ui://widget",
        toolId: "tool-1",
        toolName: "draw",
        template: "https://example.com/template.html",
      }),
    (error) =>
      error instanceof CliError &&
      error.code === "VALIDATION_ERROR" &&
      error.message.includes("Template must use ui:// protocol"),
  );
});

test("buildChatGptWidgetContent injects runtime head and csp metadata", async () => {
  const manager = createMockManager([
    {
      text: "<html><head></head><body><main>ChatGPT Widget</main></body></html>",
      _meta: {
        "openai/widgetCSP": {
          connect_domains: ["https://api.example.com"],
        },
        "openai/widgetDescription": "A widget",
        "openai/widgetPrefersBorder": false,
        "openai/closeWidget": true,
      },
    },
  ]);

  const result = await buildChatGptWidgetContent(manager, "srv", {
    uri: "ui://widget",
    toolId: "tool-2",
    toolName: "search",
    theme: "light",
  });

  assert.match(result.html, /openai-runtime-config/);
  assert.match(result.html, /Content-Security-Policy/);
  assert.equal(result.csp.mode, "permissive");
  assert.equal(result.widgetDescription, "A widget");
  assert.equal(result.prefersBorder, false);
  assert.equal(result.closeWidget, true);
});
