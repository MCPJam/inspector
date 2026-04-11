#!/usr/bin/env node
'use strict';

var commander = require('commander');
var sdk = require('@mcpjam/sdk');
var fs = require('fs');
var promises = require('fs/promises');
var path = require('path');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var path__default = /*#__PURE__*/_interopDefault(path);

// src/lib/output.ts
var DEFAULT_OUTPUT_FORMAT = "json";
var CliError = class extends Error {
  code;
  exitCode;
  details;
  constructor(code, message, exitCode, details) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
};
function cliError(code, message, exitCode = 1, details) {
  return new CliError(code, message, exitCode, details);
}
function usageError(message, details) {
  return new CliError("USAGE_ERROR", message, 2, details);
}
function operationalError(message, details) {
  return new CliError("OPERATIONAL_ERROR", message, 1, details);
}
function normalizeCliError(error) {
  if (error instanceof CliError) {
    return error;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return cliError("TIMEOUT", message);
  }
  if (lower.includes("connect") || lower.includes("connection") || lower.includes("refused") || lower.includes("econn")) {
    return cliError("SERVER_UNREACHABLE", message);
  }
  return cliError("INTERNAL_ERROR", message);
}
function stringify(value, format) {
  return format === "human" ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}
function writeResult(value, format = DEFAULT_OUTPUT_FORMAT) {
  process.stdout.write(`${stringify(value, format)}
`);
}
function toStructuredError(error) {
  if (error instanceof CliError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...error.details === void 0 ? {} : { details: error.details }
      }
    };
  }
  if (error instanceof Error) {
    return {
      error: {
        code: "UNEXPECTED_ERROR",
        message: error.message
      }
    };
  }
  return {
    error: {
      code: "UNEXPECTED_ERROR",
      message: typeof error === "string" ? error : "Unknown error"
    }
  };
}
function writeError(error, format = DEFAULT_OUTPUT_FORMAT) {
  const payload = toStructuredError(error);
  process.stderr.write(`${stringify(payload, format)}
`);
  return payload;
}
function parseOutputFormat(value) {
  if (value === "json" || value === "human") {
    return value;
  }
  throw usageError(`Invalid output format "${value}". Use "json" or "human".`);
}
function detectOutputFormatFromArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--format") {
      return parseLooseOutputFormat(argv[index + 1]);
    }
    if (token.startsWith("--format=")) {
      return parseLooseOutputFormat(token.slice("--format=".length));
    }
  }
  return DEFAULT_OUTPUT_FORMAT;
}
function parseLooseOutputFormat(value) {
  return value === "human" ? "human" : DEFAULT_OUTPUT_FORMAT;
}
function setProcessExitCode(code) {
  process.exitCode = code;
}

// src/lib/apps.ts
async function buildMcpWidgetContent(manager, serverId, options) {
  if (options.template && !options.template.startsWith("ui://")) {
    throw cliError(
      "VALIDATION_ERROR",
      "Template must use ui:// protocol"
    );
  }
  const resolvedResourceUri = options.template || options.resourceUri;
  const effectiveCspMode = options.cspMode ?? "permissive";
  const resourceResult = await manager.readResource(serverId, {
    uri: resolvedResourceUri
  });
  const contents = Array.isArray(resourceResult?.contents) ? resourceResult.contents : [];
  const content = contents[0];
  if (!content) {
    throw cliError("NOT_FOUND", "No content in resource");
  }
  const contentMimeType = content.mimeType;
  const mimeTypeValid = contentMimeType === sdk.MCP_UI_RESOURCE_MIME_TYPE;
  const mimeTypeWarning = !mimeTypeValid ? contentMimeType ? `Invalid mimetype "${contentMimeType}" - SEP-1865 requires "${sdk.MCP_UI_RESOURCE_MIME_TYPE}"` : `Missing mimetype - SEP-1865 requires "${sdk.MCP_UI_RESOURCE_MIME_TYPE}"` : null;
  let html = extractHtmlFromResourceContent(content);
  if (!html) {
    throw cliError("NOT_FOUND", "No HTML content in resource");
  }
  const uiMeta = content._meta?.ui;
  html = sdk.injectOpenAICompat(html, {
    toolId: options.toolId,
    toolName: options.toolName,
    toolInput: options.toolInput ?? {},
    toolOutput: options.toolOutput,
    theme: options.theme,
    viewMode: options.viewMode,
    viewParams: options.viewParams
  });
  return {
    html,
    csp: effectiveCspMode === "permissive" ? void 0 : uiMeta?.csp,
    permissions: uiMeta?.permissions,
    permissive: effectiveCspMode === "permissive",
    cspMode: effectiveCspMode,
    prefersBorder: uiMeta?.prefersBorder,
    mimeType: contentMimeType,
    mimeTypeValid,
    mimeTypeWarning
  };
}
async function buildChatGptWidgetContent(manager, serverId, options) {
  const content = await manager.readResource(serverId, { uri: options.uri });
  const contentsArray = Array.isArray(content?.contents) ? content.contents : [];
  const firstContent = contentsArray[0];
  if (!firstContent) {
    throw cliError("NOT_FOUND", "No HTML content found");
  }
  const htmlContent = extractHtmlFromResourceContent(firstContent);
  if (!htmlContent) {
    throw cliError("NOT_FOUND", "No HTML content found");
  }
  const resourceMeta = firstContent?._meta;
  const widgetCspRaw = resourceMeta?.["openai/widgetCSP"];
  const effectiveCspMode = options.cspMode ?? "permissive";
  const cspConfig = sdk.buildCspHeader(effectiveCspMode, widgetCspRaw);
  const runtimeHeadContent = sdk.buildChatGptRuntimeHead({
    htmlContent,
    runtimeConfig: {
      toolId: options.toolId,
      toolName: options.toolName,
      toolInput: options.toolInput ?? {},
      toolOutput: options.toolOutput ?? null,
      toolResponseMetadata: options.toolResponseMetadata ?? null,
      theme: options.theme ?? "dark",
      locale: options.locale ?? "en-US",
      deviceType: options.deviceType ?? "desktop",
      viewMode: "inline",
      viewParams: {},
      useMapPendingCalls: true
    }
  });
  let cspMetaTag = "";
  if (cspConfig.headerString) {
    const metaCspContent = sdk.buildCspMetaContent(cspConfig.headerString);
    cspMetaTag = `<meta http-equiv="Content-Security-Policy" content="${metaCspContent.replace(/"/g, "&quot;")}">`;
  }
  return {
    html: sdk.injectScripts(htmlContent, cspMetaTag + runtimeHeadContent),
    csp: {
      mode: cspConfig.mode,
      connectDomains: cspConfig.connectDomains,
      resourceDomains: cspConfig.resourceDomains,
      frameDomains: cspConfig.frameDomains,
      headerString: cspConfig.headerString,
      widgetDeclared: widgetCspRaw ?? null
    },
    widgetDescription: resourceMeta?.["openai/widgetDescription"],
    prefersBorder: resourceMeta?.["openai/widgetPrefersBorder"] ?? true,
    closeWidget: resourceMeta?.["openai/closeWidget"] ?? false
  };
}
function extractHtmlFromResourceContent(content) {
  if (!content || typeof content !== "object") {
    return "";
  }
  const record = content;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.blob === "string") {
    return Buffer.from(record.blob, "base64").toString("utf-8");
  }
  return "";
}
async function withEphemeralManager(config, fn, options) {
  const manager = new sdk.MCPClientManager(
    {},
    {
      defaultTimeout: options?.timeout ?? 3e4,
      defaultClientName: "mcpjam",
      lazyConnect: true,
      ...options?.rpcLogger ? { rpcLogger: options.rpcLogger } : {}
    }
  );
  const serverId = "__cli__";
  try {
    await manager.connectToServer(serverId, config);
    return await fn(manager, serverId);
  } finally {
    try {
      await manager.disconnectAllServers();
    } catch {
    }
  }
}
async function withEphemeralManagers(servers, fn, options) {
  const manager = new sdk.MCPClientManager(
    {},
    {
      defaultTimeout: options?.timeout ?? 3e4,
      defaultClientName: "mcpjam",
      lazyConnect: true,
      ...options?.rpcLogger ? { rpcLogger: options.rpcLogger } : {}
    }
  );
  const connectionErrors = {};
  try {
    await Promise.all(
      Object.entries(servers).map(async ([serverId, config]) => {
        try {
          await manager.connectToServer(serverId, config);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          connectionErrors[serverId] = message;
          if (!options?.continueOnConnectError) ;
        }
      })
    );
    return await fn(manager, connectionErrors);
  } finally {
    try {
      await manager.disconnectAllServers();
    } catch {
    }
  }
}

// src/lib/redaction.ts
function redactSensitiveValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSensitiveString(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      shouldRedactKey(key) ? "[REDACTED]" : redactSensitiveValue(entryValue)
    ])
  );
}
function redactSensitiveString(value) {
  return value.replace(
    /\bBearer\s+(?![A-Za-z_][A-Za-z0-9_-]*=)([A-Za-z0-9\-._~+/]+=*)/giu,
    "Bearer [REDACTED]"
  ).replace(
    /\b(access_token|refresh_token|client_secret|id_token|accessToken|refreshToken|clientSecret|idToken)=([^&\s]+)/giu,
    "$1=[REDACTED]"
  ).replace(
    /(["']?(?:access_token|refresh_token|client_secret|id_token|accessToken|refreshToken|clientSecret|idToken)["']?\s*:\s*["'])[^"']*(["'])/giu,
    "$1[REDACTED]$2"
  );
}
function shouldRedactKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return normalized === "authorization" || normalized === "proxyauthorization" || normalized === "cookie" || normalized === "setcookie" || normalized === "accesstoken" || normalized === "refreshtoken" || normalized === "clientsecret" || normalized === "idtoken" || normalized === "apikey" || normalized === "xapikey";
}

// src/lib/rpc-logs.ts
var CliRpcLogCollector = class {
  constructor(serverNamesById) {
    this.serverNamesById = serverNamesById;
  }
  serverNamesById;
  logs = [];
  rpcLogger = ({ direction, message, serverId }) => {
    this.logs.push({
      serverId,
      serverName: this.serverNamesById[serverId] ?? serverId,
      direction,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      message
    });
  };
  hasLogs() {
    return this.logs.length > 0;
  }
  getLogs() {
    return this.logs.map((event) => ({ ...event }));
  }
};
function createCliRpcLogCollector(serverNamesById) {
  return new CliRpcLogCollector(serverNamesById);
}
function attachCliRpcLogs(payload, collector) {
  if (!collector?.hasLogs() || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return {
    ...payload,
    _rpcLogs: getCliRpcLogEvents([collector])
  };
}
function getCliRpcLogEvents(collectors) {
  return collectors.flatMap((collector) => redactCliRpcLogs(collector?.getLogs() ?? []));
}
function redactCliRpcLogs(logs) {
  return logs.map((event) => ({
    ...event,
    message: redactSensitiveValue(event.message)
  }));
}

// src/lib/server-config.ts
function collectString(value, previous = []) {
  return [...previous, value];
}
function addSharedServerOptions(command) {
  return command.option("--url <url>", "HTTP MCP server URL").option("--access-token <token>", "Bearer access token for HTTP servers").option(
    "--oauth-access-token <token>",
    "OAuth bearer access token for HTTP servers"
  ).option(
    "--refresh-token <token>",
    "OAuth refresh token for HTTP servers"
  ).option(
    "--client-id <id>",
    "OAuth client ID used with --refresh-token"
  ).option(
    "--client-secret <secret>",
    "OAuth client secret used with --refresh-token"
  ).option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    collectString,
    []
  ).option(
    "--client-capabilities <json>",
    "Client capabilities advertised to the server as a JSON object"
  ).option("--command <command>", "Command for a stdio MCP server").option(
    "--command-args <arg>",
    "Stdio command argument. Repeat to pass multiple arguments.",
    collectString
  ).option(
    "--env <env>",
    'Stdio environment assignment in "KEY=VALUE" format. Repeat to pass multiple assignments.',
    collectString
  );
}
function getGlobalOptions(command) {
  const options = command.optsWithGlobals();
  return {
    format: parseOutputFormat(options.format ?? "json"),
    timeout: options.timeout ?? 3e4,
    rpc: options.rpc ?? false
  };
}
function parsePositiveInteger(value, label = "Value") {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw usageError(`${label} must be a positive integer.`);
  }
  return parsed;
}
function parseHeadersOption(headers) {
  if (!headers || headers.length === 0) {
    return void 0;
  }
  return Object.fromEntries(headers.map(parseHeader));
}
function parseJsonRecord(value, label) {
  if (value === void 0) {
    return void 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw usageError(`${label} must be valid JSON.`, {
      source: error instanceof Error ? error.message : String(error)
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError(`${label} must be a JSON object.`);
  }
  return parsed;
}
function parseUnknownRecord(value, label) {
  if (value === void 0) {
    return void 0;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw usageError(`${label} must be a JSON object.`);
  }
  return value;
}
function parsePromptArguments(value) {
  const raw = parseJsonRecord(value, "Prompt arguments");
  if (!raw) {
    return void 0;
  }
  return Object.fromEntries(
    Object.entries(raw).map(([key, entryValue]) => [key, String(entryValue)])
  );
}
function parseServerConfig(options) {
  const url = options.url?.trim();
  const command = options.command?.trim();
  const hasUrl = Boolean(url);
  const hasCommand = Boolean(command);
  const clientCapabilities = resolveClientCapabilities(
    options.clientCapabilities
  );
  if (hasUrl === hasCommand) {
    throw usageError("Specify exactly one target: either --url or --command.");
  }
  if (hasUrl && url) {
    if ((options.commandArgs?.length ?? 0) > 0 || (options.env?.length ?? 0) > 0) {
      throw usageError(
        "--command-args and --env can only be used together with --command."
      );
    }
    try {
      new URL(url);
    } catch {
      throw usageError(`Invalid URL: ${url}`);
    }
    const headers = parseHeadersOption(options.header);
    const accessToken = resolveHttpAccessToken(options);
    const refreshToken = options.refreshToken?.trim();
    const clientId = options.clientId?.trim();
    const clientSecret = options.clientSecret?.trim();
    if (refreshToken && accessToken) {
      throw usageError(
        "--refresh-token cannot be used together with --access-token or --oauth-access-token."
      );
    }
    if (refreshToken && !clientId) {
      throw usageError("--client-id is required when --refresh-token is used.");
    }
    if (!refreshToken && (clientId || clientSecret)) {
      throw usageError(
        "--client-id and --client-secret can only be used together with --refresh-token."
      );
    }
    return {
      url,
      ...accessToken ? { accessToken } : {},
      ...refreshToken ? { refreshToken } : {},
      ...clientId ? { clientId } : {},
      ...clientSecret ? { clientSecret } : {},
      ...clientCapabilities ? { clientCapabilities } : {},
      requestInit: headers ? { headers } : void 0,
      timeout: options.timeout
    };
  }
  if (!command) {
    throw usageError("Missing stdio command.");
  }
  if (options.accessToken || options.oauthAccessToken || options.refreshToken || options.clientId || options.clientSecret || (options.header?.length ?? 0) > 0) {
    throw usageError(
      "--access-token, --oauth-access-token, --refresh-token, --client-id, --client-secret, and --header can only be used together with --url."
    );
  }
  return {
    command,
    args: parseCommandArgs(options.commandArgs),
    env: parseEnvironmentOption(options.env),
    ...clientCapabilities ? { clientCapabilities } : {},
    stderr: "ignore",
    timeout: options.timeout
  };
}
function addGlobalOptions(program) {
  return program.option(
    "--timeout <ms>",
    "Request timeout in milliseconds",
    (value) => parsePositiveInteger(value, "Timeout"),
    3e4
  ).option("--rpc", "Include RPC logs in JSON output").option("--format <format>", "Output format");
}
function parseServerTargets(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw usageError("Servers must be valid JSON.", {
      source: error instanceof Error ? error.message : String(error)
    });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw usageError("Servers must be a non-empty JSON array.");
  }
  const targets = parsed.map(
    (entry, index) => parseServerTargetEntry(entry, index)
  );
  const seenIds = /* @__PURE__ */ new Set();
  for (const target of targets) {
    if (seenIds.has(target.id)) {
      throw usageError(`Duplicate server id "${target.id}" in --servers.`);
    }
    seenIds.add(target.id);
  }
  return targets;
}
function describeTarget(options) {
  return options.url?.trim() || options.command?.trim() || "__cli__";
}
function parseHeader(entry) {
  const separatorIndex = entry.indexOf(":");
  if (separatorIndex <= 0) {
    throw usageError(
      `Invalid header "${entry}". Expected the format "Key: Value".`
    );
  }
  const key = entry.slice(0, separatorIndex).trim();
  const value = entry.slice(separatorIndex + 1).trim();
  if (!key) {
    throw usageError(`Invalid header "${entry}". Header name is required.`);
  }
  return [key, value];
}
function parseCommandArgs(values) {
  if (!values || values.length === 0) {
    return void 0;
  }
  return values;
}
function parseEnvironmentOption(values) {
  if (!values || values.length === 0) {
    return void 0;
  }
  return Object.fromEntries(
    values.map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0) {
        throw usageError(
          `Invalid env assignment "${entry}". Expected KEY=VALUE.`
        );
      }
      const key = entry.slice(0, separatorIndex).trim();
      const envValue = entry.slice(separatorIndex + 1);
      if (!key) {
        throw usageError(
          `Invalid env assignment "${entry}". Environment key is required.`
        );
      }
      return [key, envValue];
    })
  );
}
function parseServerTargetEntry(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw usageError(`Server entry ${index + 1} must be an object.`);
  }
  const record = value;
  const idValue = record.id ?? record.serverId;
  if (typeof idValue !== "string" || idValue.trim().length === 0) {
    throw usageError(`Server entry ${index + 1} is missing a non-empty "id".`);
  }
  const headerEntries = Array.isArray(record.header) && record.header.every((item) => typeof item === "string") ? record.header : record.headers ? recordToHeaderEntries(parseUnknownRecord(record.headers, "headers")) : void 0;
  const envEntries = Array.isArray(record.env) ? coerceStringArray(record.env, "env") : record.env ? recordToEnvEntries(parseUnknownRecord(record.env, "env")) : void 0;
  const timeout = typeof record.timeout === "number" ? record.timeout : typeof record.timeout === "string" ? parsePositiveInteger(record.timeout, "Server timeout") : void 0;
  const config = parseServerConfig({
    url: readOptionalString(record.url),
    accessToken: readOptionalString(record.accessToken),
    oauthAccessToken: readOptionalString(record.oauthAccessToken),
    refreshToken: readOptionalString(record.refreshToken),
    clientId: readOptionalString(record.clientId),
    clientSecret: readOptionalString(record.clientSecret),
    header: headerEntries,
    clientCapabilities: parseUnknownRecord(
      record.clientCapabilities,
      "clientCapabilities"
    ),
    command: readOptionalString(record.command),
    commandArgs: Array.isArray(record.commandArgs) ? coerceStringArray(record.commandArgs, "commandArgs") : Array.isArray(record.args) ? coerceStringArray(record.args, "args") : void 0,
    env: envEntries,
    timeout
  });
  const name = readOptionalString(record.name);
  return {
    id: idValue.trim(),
    ...name ? { name } : {},
    config
  };
}
function resolveClientCapabilities(value) {
  if (value === void 0) {
    return void 0;
  }
  if (typeof value === "string") {
    return parseJsonRecord(value, "Client capabilities");
  }
  return parseUnknownRecord(value, "Client capabilities");
}
function resolveHttpAccessToken(options) {
  const accessToken = options.accessToken?.trim();
  const oauthAccessToken = options.oauthAccessToken?.trim();
  if (accessToken && oauthAccessToken && accessToken !== oauthAccessToken) {
    throw usageError(
      "--access-token and --oauth-access-token must match when both are provided."
    );
  }
  return accessToken ?? oauthAccessToken;
}
function readOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function coerceStringArray(values, label) {
  if (values.some((entry) => typeof entry !== "string")) {
    throw usageError(`${label} must be an array of strings.`);
  }
  return values;
}
function recordToHeaderEntries(value) {
  if (!value) {
    return void 0;
  }
  return Object.entries(value).map(([key, entryValue]) => {
    if (typeof entryValue !== "string") {
      throw usageError("headers values must be strings.");
    }
    return `${key}: ${entryValue}`;
  });
}
function recordToEnvEntries(value) {
  if (!value) {
    return void 0;
  }
  return Object.entries(value).map(([key, entryValue]) => {
    if (typeof entryValue !== "string") {
      throw usageError("env values must be strings.");
    }
    return `${key}=${entryValue}`;
  });
}

// src/commands/apps.ts
function registerAppsCommands(program) {
  const apps = program.command("apps").description("Fetch MCP App and ChatGPT App widget content");
  addSharedServerOptions(
    apps.command("mcp-widget").description("Fetch hosted-style MCP App widget content").requiredOption("--resource-uri <uri>", "Widget resource URI").requiredOption("--tool-id <id>", "Tool call id used for runtime injection").requiredOption("--tool-name <name>", "Tool name used for runtime injection").option("--tool-input <json>", "Tool input payload as JSON").option("--tool-output <json>", "Tool output payload as JSON").option("--theme <theme>", "Widget theme: light or dark").option(
      "--csp-mode <mode>",
      "CSP mode: permissive or widget-declared"
    ).option("--template <uri>", "Optional ui:// template override").option("--view-mode <mode>", "Widget view mode").option("--view-params <json>", "Widget view params as JSON")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => buildMcpWidgetContent(manager, serverId, {
        resourceUri: options.resourceUri,
        toolId: options.toolId,
        toolName: options.toolName,
        toolInput: parseJsonRecord(options.toolInput, "Tool input") ?? {},
        toolOutput: parseJsonValue(options.toolOutput),
        theme: parseTheme(options.theme),
        cspMode: parseCspMode(options.cspMode),
        template: options.template,
        viewMode: options.viewMode,
        viewParams: parseJsonRecord(options.viewParams, "View params")
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    apps.command("chatgpt-widget").description("Fetch hosted-style ChatGPT App widget content").requiredOption("--uri <uri>", "Widget resource URI").requiredOption("--tool-id <id>", "Tool call id used for runtime injection").requiredOption("--tool-name <name>", "Tool name used for runtime injection").option("--tool-input <json>", "Tool input payload as JSON").option("--tool-output <json>", "Tool output payload as JSON").option(
      "--tool-response-metadata <json>",
      "Tool response metadata as a JSON object"
    ).option("--theme <theme>", "Widget theme: light or dark").option(
      "--csp-mode <mode>",
      "CSP mode: permissive or widget-declared"
    ).option("--locale <locale>", "Locale override").option("--device-type <type>", "Device type: mobile, tablet, or desktop")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => buildChatGptWidgetContent(manager, serverId, {
        uri: options.uri,
        toolId: options.toolId,
        toolName: options.toolName,
        toolInput: parseJsonRecord(options.toolInput, "Tool input") ?? {},
        toolOutput: parseJsonValue(options.toolOutput),
        toolResponseMetadata: parseJsonRecord(
          options.toolResponseMetadata,
          "Tool response metadata"
        ) ?? null,
        theme: parseTheme(options.theme),
        cspMode: parseCspMode(options.cspMode),
        locale: options.locale,
        deviceType: parseDeviceType(options.deviceType)
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });
}
function withRpcLogsIfRequested(value, collector, options) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }
  return attachCliRpcLogs(value, collector);
}
function parseJsonValue(value) {
  if (value === void 0) {
    return void 0;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw usageError("Value must be valid JSON.", {
      source: error instanceof Error ? error.message : String(error)
    });
  }
}
function parseTheme(value) {
  if (value === void 0) {
    return void 0;
  }
  if (value === "light" || value === "dark") {
    return value;
  }
  throw usageError(`Invalid theme "${value}". Use "light" or "dark".`);
}
function parseCspMode(value) {
  if (value === void 0) {
    return void 0;
  }
  if (value === "permissive" || value === "widget-declared") {
    return value;
  }
  throw usageError(
    `Invalid CSP mode "${value}". Use "permissive" or "widget-declared".`
  );
}
function parseDeviceType(value) {
  if (value === void 0) {
    return void 0;
  }
  if (value === "mobile" || value === "tablet" || value === "desktop") {
    return value;
  }
  throw usageError(
    `Invalid device type "${value}". Use "mobile", "tablet", or "desktop".`
  );
}
function registerProtocolCommands(program) {
  const protocol = program.command("protocol").description("MCP protocol inspection and conformance checks");
  protocol.command("conformance").description("Run MCP protocol conformance checks against an HTTP server").requiredOption("--url <url>", "MCP server URL").option("--access-token <token>", "Bearer access token for HTTP servers").option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option(
    "--check-timeout <ms>",
    "Per-check timeout in milliseconds",
    (value) => parsePositiveInteger(value, "Check timeout"),
    15e3
  ).option(
    "--category <category>",
    "Check category to run. Repeat for multiple. Default: all.",
    (value, previous = []) => [...previous, value],
    []
  ).option(
    "--check-id <id>",
    "Specific check ID to run. Repeat for multiple. Default: all.",
    (value, previous = []) => [...previous, value],
    []
  ).action(async (options, command) => {
    const format = getFormat(command);
    const config = buildConfig(options);
    const result = await new sdk.MCPConformanceTest(config).run();
    writeResult(result, format);
    if (!result.passed) {
      setProcessExitCode(1);
    }
  });
}
function getFormat(command) {
  const opts = command.optsWithGlobals();
  const value = opts.format ?? "json";
  if (value === "json" || value === "human") {
    return value;
  }
  throw usageError(`Invalid output format "${value}". Use "json" or "human".`);
}
function collectInvalidEntries(values, allowedValues) {
  return (values ?? []).filter((value) => !allowedValues.includes(value));
}
function buildConfig(options) {
  const serverUrl = options.url.trim();
  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw usageError(`Invalid URL: ${serverUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError(`Invalid URL scheme: ${serverUrl}`);
  }
  const customHeaders = parseHeadersOption(options.header);
  const categories = options.category?.filter(Boolean);
  const invalidCategories = collectInvalidEntries(
    categories,
    sdk.MCP_CHECK_CATEGORIES
  );
  if (invalidCategories.length > 0) {
    throw usageError(
      invalidCategories.length === 1 ? `Unknown category: ${invalidCategories[0]}` : `Unknown categories: ${invalidCategories.join(", ")}`
    );
  }
  const checkIds = options.checkId?.filter(Boolean);
  const invalidCheckIds = collectInvalidEntries(checkIds, sdk.MCP_CHECK_IDS);
  if (invalidCheckIds.length > 0) {
    throw usageError(
      `Unknown check id${invalidCheckIds.length === 1 ? "" : "s"}: ${invalidCheckIds.join(", ")}`
    );
  }
  return {
    serverUrl,
    accessToken: options.accessToken,
    customHeaders,
    checkTimeout: options.checkTimeout ?? 15e3,
    ...categories && categories.length > 0 ? { categories } : {},
    ...checkIds && checkIds.length > 0 ? { checkIds } : {}
  };
}

// src/lib/oauth-enums.ts
var VALID_PROTOCOL_VERSIONS = /* @__PURE__ */ new Set([
  "2025-03-26",
  "2025-06-18",
  "2025-11-25"
]);
var VALID_REGISTRATION_STRATEGIES = /* @__PURE__ */ new Set([
  "cimd",
  "dcr",
  "preregistered"
]);
var VALID_AUTH_MODES = /* @__PURE__ */ new Set([
  "headless",
  "interactive",
  "client_credentials"
]);
function assertValidUrl(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw usageError(`${label} is required and must be a non-empty string`);
  }
  try {
    new URL(value);
  } catch {
    throw usageError(`Invalid ${label}: ${value}`);
  }
}
function assertEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw usageError(
      `Invalid ${label} "${String(value)}". Allowed: ${[...allowed].join(", ")}`
    );
  }
}
function validateFlow(flow, defaults, index) {
  const protocolVersion = flow.protocolVersion ?? defaults?.protocolVersion;
  if (!protocolVersion) {
    throw usageError(
      `flows[${index}]: protocolVersion is required (not set in flow or defaults)`
    );
  }
  assertEnum(protocolVersion, VALID_PROTOCOL_VERSIONS, `flows[${index}].protocolVersion`);
  const registrationStrategy = flow.registrationStrategy ?? defaults?.registrationStrategy;
  if (!registrationStrategy) {
    throw usageError(
      `flows[${index}]: registrationStrategy is required (not set in flow or defaults)`
    );
  }
  assertEnum(
    registrationStrategy,
    VALID_REGISTRATION_STRATEGIES,
    `flows[${index}].registrationStrategy`
  );
  const auth = flow.auth ?? defaults?.auth;
  if (auth?.mode) {
    assertEnum(auth.mode, VALID_AUTH_MODES, `flows[${index}].auth.mode`);
  }
}
function loadSuiteConfig(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw usageError(
      `Cannot read config file "${filePath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw usageError(`Config file "${filePath}" is not valid JSON`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw usageError("Config file must be a JSON object");
  }
  assertValidUrl(config.serverUrl, "serverUrl");
  const flows = config.flows;
  if (!Array.isArray(flows) || flows.length === 0) {
    throw usageError('Config file must have a non-empty "flows" array');
  }
  const defaults = config.defaults;
  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    if (typeof flow !== "object" || flow === null || Array.isArray(flow)) {
      throw usageError(`flows[${i}] must be an object`);
    }
    validateFlow(flow, defaults, i);
  }
  return config;
}

// src/lib/junit-xml.ts
function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function stepToTestCase(step, classname) {
  const name = escapeXml(step.title || step.step);
  const time = (step.durationMs / 1e3).toFixed(3);
  const cls = escapeXml(classname);
  if (step.status === "skipped") {
    return `    <testcase name="${name}" classname="${cls}" time="${time}">
      <skipped/>
    </testcase>`;
  }
  if (step.status === "failed") {
    const message = escapeXml(step.error?.message ?? "Unknown failure");
    const details = step.httpAttempts.map((attempt) => {
      const req = `${attempt.request.method} ${attempt.request.url}`;
      const res = attempt.response ? `${attempt.response.status} ${attempt.response.statusText}` : "No response";
      return `${req} \u2192 ${res}`;
    }).join("\n");
    const body = details ? escapeXml(details) : "";
    return `    <testcase name="${name}" classname="${cls}" time="${time}">
      <failure message="${message}">${body}</failure>
    </testcase>`;
  }
  return `    <testcase name="${name}" classname="${cls}" time="${time}"/>`;
}
function flowToTestSuite(result) {
  const name = escapeXml(result.label);
  const tests = result.steps.length;
  const failures = result.steps.filter((s) => s.status === "failed").length;
  const skipped = result.steps.filter((s) => s.status === "skipped").length;
  const time = (result.durationMs / 1e3).toFixed(3);
  const classname = result.serverUrl;
  const cases = result.steps.map((step) => stepToTestCase(step, classname)).join("\n");
  return `  <testsuite name="${name}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">
${cases}
  </testsuite>`;
}
function suiteResultToJUnitXml(result) {
  const name = escapeXml(result.name);
  const tests = result.results.reduce((sum, r) => sum + r.steps.length, 0);
  const failures = result.results.reduce(
    (sum, r) => sum + r.steps.filter((s) => s.status === "failed").length,
    0
  );
  const time = (result.durationMs / 1e3).toFixed(3);
  const suites = result.results.map(flowToTestSuite).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${name}" tests="${tests}" failures="${failures}" time="${time}">
${suites}
</testsuites>
`;
}
function singleResultToJUnitXml(result, label) {
  const suiteResult = {
    name: "OAuth Conformance",
    serverUrl: result.serverUrl,
    passed: result.passed,
    results: [
      {
        ...result,
        label: `${result.protocolVersion}/${result.registrationStrategy}`
      }
    ],
    summary: result.summary,
    durationMs: result.durationMs
  };
  return suiteResultToJUnitXml(suiteResult);
}

// src/lib/oauth-output.ts
function parseOAuthOutputFormat(value) {
  if (value === "json" || value === "human" || value === "junit-xml") {
    return value;
  }
  throw usageError(
    `Invalid output format "${value}". Use "json", "human", or "junit-xml".`
  );
}
function resolveOAuthOutputFormat(value, isTTY) {
  return parseOAuthOutputFormat(value ?? (isTTY ? "human" : "json"));
}
function renderOAuthConformanceResult(result, format) {
  switch (format) {
    case "human":
      return sdk.formatOAuthConformanceHuman(result);
    case "junit-xml":
      return singleResultToJUnitXml(result);
    case "json":
      return JSON.stringify(result);
  }
}
function renderOAuthConformanceSuiteResult(result, format) {
  switch (format) {
    case "human":
      return sdk.formatOAuthConformanceSuiteHuman(result);
    case "junit-xml":
      return suiteResultToJUnitXml(result);
    case "json":
      return JSON.stringify(result);
  }
}
async function writeCommandDebugArtifact(options, dependencies = {}) {
  if (!options.outputPath) {
    return void 0;
  }
  const snapshotResult = options.snapshot ? await collectDoctorSnapshot(options.snapshot, dependencies) : { snapshot: null, snapshotError: null };
  const payload = buildDebugArtifactEnvelope({
    commandName: options.commandName,
    commandInput: options.commandInput,
    target: options.target,
    outcome: options.outcome,
    snapshot: snapshotResult.snapshot,
    snapshotError: snapshotResult.snapshotError,
    collectors: [
      ...options.collectors ?? [],
      options.snapshot?.collector
    ]
  });
  const artifactPath = await writeDebugArtifact(options.outputPath, payload);
  if (options.format === "human") {
    process.stderr.write(`Debug artifact: ${artifactPath}
`);
  }
  return artifactPath;
}
function buildDebugArtifactEnvelope(options) {
  const payload = {
    schemaVersion: 1,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    command: {
      name: options.commandName,
      input: options.commandInput
    },
    target: options.target,
    outcome: buildOutcome(options.outcome),
    snapshot: options.snapshot
  };
  if (options.snapshotError) {
    payload.snapshotError = options.snapshotError;
  }
  const rpcLogs = getCliRpcLogEvents(options.collectors ?? []);
  if (rpcLogs.length > 0) {
    payload._rpcLogs = rpcLogs;
  }
  return redactSensitiveValue(payload);
}
function buildCommandArtifactError(code, message, details) {
  return {
    code,
    message,
    ...{} 
  };
}
async function writeDebugArtifact(outputPath, payload) {
  const resolvedPath = path__default.default.resolve(process.cwd(), outputPath);
  const redactedPayload = redactSensitiveValue(payload);
  try {
    await promises.mkdir(path__default.default.dirname(resolvedPath), { recursive: true });
    await promises.writeFile(
      resolvedPath,
      `${JSON.stringify(redactedPayload, null, 2)}
`,
      "utf8"
    );
  } catch (error) {
    throw operationalError(
      `Failed to write debug artifact to "${resolvedPath}".`,
      {
        source: error instanceof Error ? error.message : String(error)
      }
    );
  }
  return resolvedPath;
}
async function collectDoctorSnapshot(options, dependencies = {}) {
  try {
    const runDoctor = dependencies.runDoctor ?? sdk.runServerDoctor;
    return {
      snapshot: await runDoctor({
        ...options.input,
        rpcLogger: options.collector?.rpcLogger
      }),
      snapshotError: null
    };
  } catch (error) {
    return {
      snapshot: null,
      snapshotError: normalizeArtifactError(error)
    };
  }
}
function buildOutcome(outcome) {
  if (outcome.status === "success") {
    return {
      status: "success",
      result: outcome.result
    };
  }
  return {
    status: "error",
    ...outcome.result === void 0 ? {} : { result: outcome.result },
    error: normalizeArtifactError(outcome.error)
  };
}
function normalizeArtifactError(error) {
  if (error && typeof error === "object" && typeof error.code === "string" && typeof error.message === "string") {
    return error;
  }
  return toStructuredError(normalizeCliError(error)).error;
}

// src/lib/server-doctor.ts
function summarizeServerDoctorTarget(target, config) {
  if ("url" in config) {
    return {
      kind: "http",
      label: target,
      url: config.url,
      commandArgs: [],
      envKeys: [],
      headerNames: Object.keys(extractHeaders(config.requestInit?.headers)),
      timeoutMs: config.timeout,
      hasAccessToken: Boolean(config.accessToken),
      hasRefreshToken: Boolean(config.refreshToken),
      hasClientSecret: Boolean(config.clientSecret),
      ...config.clientCapabilities ? { clientCapabilities: config.clientCapabilities } : {}
    };
  }
  return {
    kind: "stdio",
    label: target,
    command: config.command,
    commandArgs: config.args ?? [],
    envKeys: Object.keys(config.env ?? {}),
    headerNames: [],
    timeoutMs: config.timeout,
    hasAccessToken: false,
    hasRefreshToken: false,
    hasClientSecret: false,
    ...config.clientCapabilities ? { clientCapabilities: config.clientCapabilities } : {}
  };
}
function formatServerDoctorHuman(result, options = {}) {
  const lines = [`Status: ${result.status}`, `Target: ${result.target.label}`];
  if (result.probe) {
    const transport = result.probe.transport.selected ?? (result.probe.transport.attempts.length > 0 ? "attempted" : "none");
    lines.push(`Probe: ${result.probe.status} (${transport})`);
  } else {
    lines.push("Probe: skipped");
  }
  lines.push(
    `Connection: ${result.connection.status} (${result.connection.detail})`
  );
  lines.push(
    `Counts: tools ${result.tools.length}, resources ${result.resources.length}, resourceTemplates ${result.resourceTemplates.length}, prompts ${result.prompts.length}`
  );
  if (result.status === "oauth_required" && result.probe) {
    const strategies = result.probe.oauth.registrationStrategies.join(", ") || "none";
    lines.push(`OAuth: required (${strategies})`);
    lines.push(
      `Next: run \`mcpjam oauth login --url ${result.target.url ?? result.target.label}\``
    );
  } else if (result.error) {
    lines.push(`Error: ${result.error.code}: ${result.error.message}`);
  }
  lines.push("Checks:");
  for (const [name, check] of Object.entries(result.checks)) {
    lines.push(`- ${name}: ${check.status} (${check.detail})`);
  }
  if (options.artifactPath) {
    lines.push(`Artifact: ${options.artifactPath}`);
  }
  return lines.join("\n");
}
function extractHeaders(headers) {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    const normalized = {};
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([key, value]) => [key, String(value)])
    );
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)])
  );
}

// src/commands/oauth.ts
var DYNAMIC_CLIENT_ID_PLACEHOLDER = "__dynamic_registration_client__";
var DYNAMIC_CLIENT_SECRET_PLACEHOLDER = "__dynamic_registration_secret__";
function getOAuthFormat(command) {
  const opts = command.optsWithGlobals();
  return resolveOAuthOutputFormat(opts.format, process.stdout.isTTY);
}
function getStructuredOAuthFormat(command) {
  const format = getOAuthFormat(command);
  if (format === "junit-xml") {
    throw usageError(
      'The oauth metadata/proxy commands only support --format "json" or "human".'
    );
  }
  return format;
}
function writeOAuthOutput(output) {
  process.stdout.write(output.endsWith("\n") ? output : `${output}
`);
}
function registerOAuthCommands(program) {
  const oauth = program.command("oauth").description("Run MCP OAuth login, proxy, and conformance flows");
  oauth.command("login").description("Run an OAuth login flow against an HTTP MCP server").requiredOption("--url <url>", "MCP server URL").requiredOption(
    "--protocol-version <version>",
    "OAuth protocol version: 2025-03-26, 2025-06-18, or 2025-11-25"
  ).requiredOption(
    "--registration <strategy>",
    "Registration strategy: dcr, preregistered, or cimd"
  ).option(
    "--auth-mode <mode>",
    "Authorization mode: headless, interactive, or client_credentials",
    "interactive"
  ).option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option("--client-id <id>", "OAuth client ID").option("--client-secret <secret>", "OAuth client secret").option(
    "--client-metadata-url <url>",
    "Client metadata URL used for CIMD registration"
  ).option("--redirect-url <url>", "OAuth redirect URL to use for the flow").option("--scopes <scopes>", "Space-separated scope string").option(
    "--step-timeout <ms>",
    "Per-step timeout in milliseconds",
    (value) => parsePositiveInteger(value, "Step timeout"),
    3e4
  ).option(
    "--verify-tools",
    "After OAuth succeeds, verify the token by listing MCP tools"
  ).option(
    "--verify-call-tool <name>",
    "After listing tools, also call the named tool"
  ).option(
    "--debug-out <path>",
    "Write a structured debug artifact to a file"
  ).action(async (options, command) => {
    const format = getStructuredOAuthFormat(command);
    const config = buildOAuthConformanceConfig(
      options,
      {
        defaultAuthMode: "interactive"
      }
    );
    const snapshotCollector = options.debugOut ? createCliRpcLogCollector({ __cli__: config.serverUrl }) : void 0;
    let result;
    let commandError;
    try {
      result = await sdk.runOAuthLogin(config);
    } catch (error) {
      commandError = error;
    }
    const snapshotConfig = buildOAuthLoginSnapshotConfig(config, result);
    const target = summarizeServerDoctorTarget(
      config.serverUrl,
      snapshotConfig
    );
    await writeCommandDebugArtifact({
      outputPath: options.debugOut,
      format,
      commandName: "oauth login",
      commandInput: summarizeOAuthLoginCommandInput(
        options
      ),
      target,
      outcome: commandError ? {
        status: "error",
        error: commandError
      } : result?.completed ? {
        status: "success",
        result
      } : {
        status: "error",
        result,
        error: buildCommandArtifactError(
          "OAUTH_LOGIN_INCOMPLETE",
          result?.error?.message ?? "OAuth login did not complete."
        )
      },
      snapshot: options.debugOut ? {
        input: {
          config: snapshotConfig,
          target,
          timeout: config.stepTimeout ?? 3e4
        },
        collector: snapshotCollector
      } : void 0
    });
    if (commandError) {
      throw commandError;
    }
    if (!result) {
      throw cliError("INTERNAL_ERROR", "OAuth login did not return a result.");
    }
    writeResult(result, format);
    if (!result.completed) {
      setProcessExitCode(1);
    }
  });
  oauth.command("conformance").description("Run OAuth conformance against an HTTP MCP server").requiredOption("--url <url>", "MCP server URL").requiredOption(
    "--protocol-version <version>",
    "OAuth protocol version: 2025-03-26, 2025-06-18, or 2025-11-25"
  ).requiredOption(
    "--registration <strategy>",
    "Registration strategy: dcr, preregistered, or cimd"
  ).option(
    "--auth-mode <mode>",
    "Authorization mode: headless, interactive, or client_credentials",
    "headless"
  ).option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option("--client-id <id>", "OAuth client ID").option("--client-secret <secret>", "OAuth client secret").option(
    "--client-metadata-url <url>",
    "Client metadata URL used for CIMD registration"
  ).option("--redirect-url <url>", "OAuth redirect URL to use for the flow").option("--scopes <scopes>", "Space-separated scope string").option(
    "--step-timeout <ms>",
    "Per-step timeout in milliseconds",
    (value) => parsePositiveInteger(value, "Step timeout"),
    3e4
  ).option(
    "--verify-tools",
    "After OAuth succeeds, verify the token by listing MCP tools"
  ).option(
    "--verify-call-tool <name>",
    "After listing tools, also call the named tool"
  ).action(async (options, command) => {
    const format = getOAuthFormat(command);
    const config = buildOAuthConformanceConfig(options);
    const result = await new sdk.OAuthConformanceTest(config).run();
    writeOAuthOutput(renderOAuthConformanceResult(result, format));
    if (!result.passed) {
      setProcessExitCode(1);
    }
  });
  oauth.command("conformance-suite").description(
    "Run a matrix of OAuth conformance flows from a JSON config file"
  ).requiredOption("--config <path>", "Path to JSON config file").option(
    "--verify-tools",
    "Enable post-auth tool listing verification on all flows"
  ).option(
    "--verify-call-tool <name>",
    "Also call the named tool after listing"
  ).action(async (options, command) => {
    const format = getOAuthFormat(command);
    const config = loadSuiteConfig(options.config);
    if (options.verifyTools || options.verifyCallTool) {
      const cliVerification = {
        listTools: true,
        ...options.verifyCallTool ? { callTool: { name: options.verifyCallTool } } : {}
      };
      for (const flow of config.flows) {
        flow.verification = { ...flow.verification, ...cliVerification };
      }
      config.defaults = {
        ...config.defaults,
        verification: { ...config.defaults?.verification, ...cliVerification }
      };
    }
    const suite = new sdk.OAuthConformanceSuite(config);
    const result = await suite.run();
    writeOAuthOutput(renderOAuthConformanceSuiteResult(result, format));
    if (!result.passed) {
      setProcessExitCode(1);
    }
  });
  oauth.command("metadata").description("Fetch OAuth metadata from a URL").requiredOption("--url <url>", "OAuth metadata URL").action(async (options, command) => {
    const result = await runOAuthMetadata(options.url);
    writeResult(result, getStructuredOAuthFormat(command));
  });
  oauth.command("proxy").description("Proxy an OAuth request with hosted-mode safety checks").requiredOption("--url <url>", "OAuth request URL").option("--method <method>", "HTTP method", "GET").option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option("--body <value>", "Request body as JSON or raw string").action(async (options, command) => {
    const result = await runOAuthProxy(options);
    writeResult(result, getStructuredOAuthFormat(command));
  });
  oauth.command("debug-proxy").description("Proxy an OAuth debug request with hosted-mode safety checks").requiredOption("--url <url>", "OAuth request URL").option("--method <method>", "HTTP method", "GET").option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option("--body <value>", "Request body as JSON or raw string").action(async (options, command) => {
    const result = await runOAuthDebugProxy(
      options
    );
    writeResult(result, getStructuredOAuthFormat(command));
  });
}
function buildOAuthConformanceConfig(options, defaults) {
  const serverUrl = options.url.trim();
  assertValidUrl2(serverUrl, "server URL");
  const protocolVersion = parseProtocolVersion(options.protocolVersion);
  const registrationStrategy = parseRegistrationStrategy(options.registration);
  const authMode = parseAuthMode(
    options.authMode ?? defaults?.defaultAuthMode ?? "headless"
  );
  if (protocolVersion !== "2025-11-25" && registrationStrategy === "cimd") {
    throw usageError(
      `CIMD registration is not supported for protocol version ${protocolVersion}.`
    );
  }
  if (authMode === "client_credentials" && registrationStrategy === "cimd") {
    throw usageError(
      "--auth-mode client_credentials cannot be used with --registration cimd. CIMD is a browser-based registration flow and only works with --auth-mode headless or --auth-mode interactive. For client_credentials, use --registration dcr or --registration preregistered instead."
    );
  }
  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret;
  const clientMetadataUrl = options.clientMetadataUrl?.trim();
  const redirectUrl = options.redirectUrl?.trim();
  if (registrationStrategy === "preregistered" && !clientId) {
    throw usageError(
      "--client-id is required when --registration preregistered is used."
    );
  }
  if (registrationStrategy === "preregistered" && authMode === "client_credentials" && !clientSecret) {
    throw usageError(
      "--client-secret is required for preregistered client_credentials runs."
    );
  }
  if (clientMetadataUrl) {
    assertValidUrl2(clientMetadataUrl, "client metadata URL");
  }
  if (redirectUrl) {
    assertValidUrl2(redirectUrl, "redirect URL");
  }
  const customHeaders = parseHeadersOption(options.header);
  const client = {};
  if (registrationStrategy === "preregistered" && clientId) {
    client.preregistered = {
      clientId,
      ...clientSecret ? { clientSecret } : {}
    };
  }
  if (clientMetadataUrl) {
    client.clientIdMetadataUrl = clientMetadataUrl;
  }
  const verification = options.verifyTools || options.verifyCallTool ? {
    listTools: options.verifyTools ?? !!options.verifyCallTool,
    ...options.verifyCallTool ? { callTool: { name: options.verifyCallTool } } : {}
  } : void 0;
  return {
    serverUrl,
    protocolVersion,
    registrationStrategy,
    auth: buildAuthConfig(authMode, registrationStrategy, clientId, clientSecret),
    client,
    scopes: options.scopes?.trim() || void 0,
    customHeaders,
    redirectUrl,
    stepTimeout: options.stepTimeout ?? 3e4,
    verification
  };
}
function summarizeOAuthLoginCommandInput(options) {
  return {
    serverUrl: options.url.trim(),
    protocolVersion: options.protocolVersion,
    registration: options.registration,
    authMode: options.authMode ?? "interactive",
    redirectUrl: options.redirectUrl?.trim() || void 0,
    scopes: options.scopes?.trim() || void 0,
    clientMetadataUrl: options.clientMetadataUrl?.trim() || void 0,
    headerNames: Object.keys(parseHeadersOption(options.header) ?? {}),
    hasClientId: Boolean(options.clientId?.trim()),
    hasClientSecret: Boolean(options.clientSecret),
    verifyTools: options.verifyTools ?? false,
    verifyCallTool: options.verifyCallTool ?? void 0,
    stepTimeout: options.stepTimeout ?? 3e4
  };
}
function buildOAuthLoginSnapshotConfig(config, result) {
  const baseConfig = {
    url: config.serverUrl,
    ...config.customHeaders ? { requestInit: { headers: config.customHeaders } } : {},
    timeout: config.stepTimeout ?? 3e4
  };
  if (!result) {
    return baseConfig;
  }
  const clientId = result.credentials.clientId ?? config.client?.preregistered?.clientId ?? (config.auth?.mode === "client_credentials" ? config.auth.clientId : void 0);
  const clientSecret = result.credentials.clientSecret ?? config.client?.preregistered?.clientSecret ?? (config.auth?.mode === "client_credentials" ? config.auth.clientSecret : void 0);
  if (result.credentials.accessToken) {
    return {
      ...baseConfig,
      accessToken: result.credentials.accessToken
    };
  }
  if (result.credentials.refreshToken && clientId) {
    return {
      ...baseConfig,
      refreshToken: result.credentials.refreshToken,
      clientId,
      ...clientSecret ? { clientSecret } : {}
    };
  }
  return baseConfig;
}
function buildAuthConfig(authMode, registrationStrategy, clientId, clientSecret) {
  switch (authMode) {
    case "headless":
      return { mode: "headless" };
    case "interactive":
      return { mode: "interactive" };
    case "client_credentials":
      return {
        mode: "client_credentials",
        clientId: clientId ?? (registrationStrategy === "dcr" ? DYNAMIC_CLIENT_ID_PLACEHOLDER : ""),
        clientSecret: clientSecret ?? (registrationStrategy === "dcr" ? DYNAMIC_CLIENT_SECRET_PLACEHOLDER : "")
      };
    default:
      throw usageError(`Unsupported auth mode "${authMode}".`);
  }
}
function assertValidUrl2(value, label) {
  try {
    new URL(value);
  } catch {
    throw usageError(`Invalid ${label}: ${value}`);
  }
}
function parseProtocolVersion(value) {
  if (VALID_PROTOCOL_VERSIONS.has(value)) {
    return value;
  }
  throw usageError(
    `Invalid protocol version "${value}". Use ${[...VALID_PROTOCOL_VERSIONS].join(", ")}.`
  );
}
function parseRegistrationStrategy(value) {
  if (VALID_REGISTRATION_STRATEGIES.has(value)) {
    return value;
  }
  throw usageError(
    `Invalid registration strategy "${value}". Use ${[...VALID_REGISTRATION_STRATEGIES].join(", ")}.`
  );
}
function parseAuthMode(value) {
  if (VALID_AUTH_MODES.has(value)) {
    return value;
  }
  throw usageError(
    `Invalid auth mode "${value}". Use ${[...VALID_AUTH_MODES].join(", ")}.`
  );
}
async function runOAuthMetadata(url) {
  try {
    const result = await sdk.fetchOAuthMetadata(url, true);
    if ("status" in result && result.status !== void 0) {
      throw cliError(
        statusToErrorCode(result.status),
        `Failed to fetch OAuth metadata: ${result.status} ${result.statusText}`
      );
    }
    return result.metadata;
  } catch (error) {
    throw mapOAuthProxyError(error);
  }
}
async function runOAuthProxy(options) {
  try {
    return await sdk.executeOAuthProxy({
      url: options.url,
      method: options.method,
      headers: parseHeadersOption(options.header),
      body: parseProxyBody(options.body),
      httpsOnly: true
    });
  } catch (error) {
    throw mapOAuthProxyError(error);
  }
}
async function runOAuthDebugProxy(options) {
  try {
    return await sdk.executeDebugOAuthProxy({
      url: options.url,
      method: options.method,
      headers: parseHeadersOption(options.header),
      body: parseProxyBody(options.body),
      httpsOnly: true
    });
  } catch (error) {
    throw mapOAuthProxyError(error);
  }
}
function parseProxyBody(value) {
  if (value === void 0) {
    return void 0;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function mapOAuthProxyError(error) {
  if (error instanceof sdk.OAuthProxyError) {
    return cliError(statusToErrorCode(error.status), error.message);
  }
  return error;
}
function statusToErrorCode(status) {
  if (status === 400) return "VALIDATION_ERROR";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 502) return "SERVER_UNREACHABLE";
  if (status === 504) return "TIMEOUT";
  return "INTERNAL_ERROR";
}
async function listToolsWithMetadata(manager, params) {
  const result = await manager.listTools(
    params.serverId,
    params.cursor ? { cursor: params.cursor } : void 0
  );
  const tools = result.tools ?? [];
  const toolsMetadata = manager.getAllToolsMetadata(params.serverId);
  const tokenCount = params.modelId ? estimateTokensFromChars(JSON.stringify(tools)) : void 0;
  return {
    tools,
    nextCursor: result.nextCursor,
    toolsMetadata,
    ...tokenCount === void 0 ? {} : { tokenCount }
  };
}
async function exportServerSnapshot(manager, serverId, target) {
  const [toolsResult, resourcesResult, promptsResult, resourceTemplatesResult] = await Promise.all([
    manager.listTools(serverId),
    manager.listResources(serverId),
    manager.listPrompts(serverId),
    manager.listResourceTemplates(serverId).catch(() => ({
      resourceTemplates: []
    }))
  ]);
  return {
    target,
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    initInfo: manager.getInitializationInfo(serverId) ?? null,
    capabilities: manager.getServerCapabilities(serverId) ?? null,
    tools: (toolsResult.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema
    })),
    toolsMetadata: manager.getAllToolsMetadata(serverId),
    resources: (resourcesResult.resources ?? []).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType
    })),
    resourceTemplates: (resourceTemplatesResult.resourceTemplates ?? []).map(
      (template) => ({
        uriTemplate: template.uriTemplate,
        name: template.name,
        description: template.description,
        mimeType: template.mimeType
      })
    ),
    prompts: (promptsResult.prompts ?? []).map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments
    }))
  };
}
async function listPromptsMulti(manager, serverIds) {
  return sdk.listPromptsMulti(manager, { serverIds });
}
function estimateTokensFromChars(text) {
  return Math.ceil(text.length / 4);
}

// src/commands/prompts.ts
function registerPromptCommands(program) {
  const prompts = program.command("prompts").description("List and fetch MCP prompts");
  addSharedServerOptions(
    prompts.command("list").description("List prompts exposed by an MCP server").option("--cursor <cursor>", "Pagination cursor")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.listPrompts(manager, { serverId, cursor: options.cursor }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested2(result, collector, globalOptions), globalOptions.format);
  });
  prompts.command("list-multi").description("List prompts across multiple server targets").requiredOption(
    "--servers <json>",
    "JSON array of server target objects with id plus url or command"
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const targets = parseServerTargets(options.servers);
    const collector = globalOptions.rpc ? createCliRpcLogCollector(
      Object.fromEntries(
        targets.map((target) => [target.id, target.name ?? target.id])
      )
    ) : void 0;
    const result = await withEphemeralManagers(
      Object.fromEntries(targets.map((target) => [target.id, target.config])),
      async (manager, connectionErrors) => {
        const promptsResult = await listPromptsMulti(
          manager,
          targets.map((target) => target.id)
        );
        const resultErrors = promptsResult.errors ?? {};
        const mergedErrors = {
          ...resultErrors,
          ...connectionErrors
        };
        return {
          prompts: promptsResult.prompts,
          ...Object.keys(mergedErrors).length === 0 ? {} : { errors: mergedErrors }
        };
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        continueOnConnectError: true
      }
    );
    writeResult(withRpcLogsIfRequested2(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    prompts.command("get").description("Get a named prompt from an MCP server").requiredOption("--name <prompt>", "Prompt name").option("--prompt-args <json>", "Prompt arguments as a JSON object")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const promptArguments = parsePromptArguments(options.promptArgs);
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.getPrompt(manager, {
        serverId,
        name: options.name,
        arguments: promptArguments
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested2(result, collector, globalOptions), globalOptions.format);
  });
}
function withRpcLogsIfRequested2(value, collector, options) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }
  return attachCliRpcLogs(value, collector);
}
function registerResourcesCommands(program) {
  const resources = program.command("resources").description("List and read MCP resources");
  addSharedServerOptions(
    resources.command("list").description("List resources exposed by an MCP server").option("--cursor <cursor>", "Pagination cursor")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.listResources(manager, { serverId, cursor: options.cursor }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested3(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    resources.command("read").description("Read a resource from an MCP server").requiredOption("--uri <uri>", "Resource URI")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.readResource(manager, { serverId, uri: options.uri }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested3(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    resources.command("templates").description("List resource templates exposed by an MCP server").option("--cursor <cursor>", "Pagination cursor")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => manager.listResourceTemplates(
        serverId,
        options.cursor ? { cursor: options.cursor } : void 0
      ),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested3(result, collector, globalOptions), globalOptions.format);
  });
}
function withRpcLogsIfRequested3(value, collector, options) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }
  return attachCliRpcLogs(value, collector);
}
function registerServerCommands(program) {
  const server = program.command("server").description("Inspect MCP server connectivity and capabilities");
  server.command("probe").description("Probe an HTTP MCP server without using the full client connect flow").requiredOption("--url <url>", "HTTP MCP server URL").option("--access-token <token>", "Bearer access token for HTTP servers").option(
    "--oauth-access-token <token>",
    "OAuth bearer access token for HTTP servers"
  ).option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option(
    "--client-capabilities <json>",
    "Client capabilities advertised in the initialize probe as a JSON object"
  ).option(
    "--protocol-version <version>",
    "OAuth/MCP protocol version hint used for the initialize probe",
    "2025-11-25"
  ).option(
    "--timeout <ms>",
    "Request timeout in milliseconds",
    (value) => parsePositiveInteger(value, "Timeout")
  ).option(
    "--debug-out <path>",
    "Write a structured debug artifact to a file"
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const protocolVersion = options.protocolVersion;
    const config = parseServerConfig({
      ...options,
      timeout: options.timeout ?? globalOptions.timeout
    });
    const target = describeTarget(options);
    const targetSummary = summarizeServerDoctorTarget(target, config);
    const snapshotCollector = options.debugOut ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    if (protocolVersion !== "2025-03-26" && protocolVersion !== "2025-06-18" && protocolVersion !== "2025-11-25") {
      throw usageError(
        `Invalid protocol version "${options.protocolVersion}".`
      );
    }
    let result;
    let commandError;
    try {
      const probeUrl = "url" in config ? config.url : void 0;
      if (!probeUrl) {
        throw usageError("HTTP probe requires --url.");
      }
      result = await sdk.probeMcpServer({
        url: probeUrl,
        protocolVersion,
        headers: parseHeadersOption(options.header),
        accessToken: resolveHttpAccessToken(options),
        clientCapabilities: "clientCapabilities" in config ? config.clientCapabilities : void 0,
        timeoutMs: options.timeout ?? globalOptions.timeout
      });
    } catch (error) {
      commandError = error;
    }
    await writeCommandDebugArtifact({
      outputPath: options.debugOut,
      format: globalOptions.format,
      commandName: "server probe",
      commandInput: {
        protocolVersion,
        clientCapabilities: "clientCapabilities" in config ? config.clientCapabilities : void 0
      },
      target: targetSummary,
      outcome: commandError ? {
        status: "error",
        error: commandError
      } : result?.status === "error" ? {
        status: "error",
        result,
        error: buildCommandArtifactError(
          "PROBE_FAILED",
          result.error ?? "Probe failed."
        )
      } : {
        status: "success",
        result
      },
      snapshot: options.debugOut ? {
        input: {
          config,
          target: targetSummary,
          timeout: options.timeout ?? globalOptions.timeout
        },
        collector: snapshotCollector
      } : void 0
    });
    if (commandError) {
      throw commandError;
    }
    if (!result) {
      throw operationalError("Probe did not return a result.");
    }
    writeResult(result, globalOptions.format);
    if (result.status === "error") {
      setProcessExitCode(1);
    }
  });
  addSharedServerOptions(
    server.command("doctor").description("Run a stateless diagnostic sweep against an MCP server").option("--out <path>", "Write the doctor JSON artifact to a file")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const doctorTarget = summarizeServerDoctorTarget(target, config);
    const result = await sdk.runServerDoctor(
      {
        config,
        target: doctorTarget,
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    const jsonPayload = globalOptions.rpc ? attachCliRpcLogs(result, collector) : result;
    const artifactPath = options.out ? await writeDebugArtifact(options.out, jsonPayload) : void 0;
    if (globalOptions.format === "human") {
      process.stdout.write(
        `${formatServerDoctorHuman(result, { artifactPath })}
`
      );
    } else {
      writeResult(jsonPayload, globalOptions.format);
    }
    if (result.status !== "ready") {
      setProcessExitCode(1);
    }
  });
  addSharedServerOptions(
    server.command("info").description("Get initialization info for an MCP server")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => {
        const info = manager.getInitializationInfo(serverId);
        if (!info) {
          throw operationalError(
            "Server connected but did not return initialization info."
          );
        }
        return info;
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested4(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    server.command("validate").description("Connect to a server and verify the debugger surface works")
  ).option(
    "--debug-out <path>",
    "Write a structured debug artifact to a file"
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const primaryCollector = globalOptions.rpc || options.debugOut ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const snapshotCollector = options.debugOut ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const targetSummary = summarizeServerDoctorTarget(target, config);
    let result;
    let commandError;
    try {
      result = await withEphemeralManager(
        config,
        async (manager, serverId) => {
          await manager.getToolsForAiSdk([serverId]);
          return {
            success: true,
            status: "connected",
            target,
            initInfo: manager.getInitializationInfo(serverId) ?? null
          };
        },
        {
          timeout: globalOptions.timeout,
          rpcLogger: primaryCollector?.rpcLogger
        }
      );
    } catch (error) {
      commandError = error;
    }
    await writeCommandDebugArtifact({
      outputPath: options.debugOut,
      format: globalOptions.format,
      commandName: "server validate",
      commandInput: {},
      target: targetSummary,
      outcome: commandError ? {
        status: "error",
        error: commandError
      } : {
        status: "success",
        result
      },
      snapshot: options.debugOut ? {
        input: {
          config,
          target: targetSummary,
          timeout: globalOptions.timeout
        },
        collector: snapshotCollector
      } : void 0,
      collectors: [primaryCollector]
    });
    if (commandError) {
      throw commandError;
    }
    writeResult(
      withRpcLogsIfRequested4(result, primaryCollector, globalOptions),
      globalOptions.format
    );
  });
  addSharedServerOptions(
    server.command("ping").description("Ping an MCP server")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => ({
        target,
        status: "connected",
        result: await manager.pingServer(serverId)
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested4(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    server.command("capabilities").description("Get resolved server capabilities")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => ({
        target,
        capabilities: manager.getServerCapabilities(serverId) ?? null
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested4(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    server.command("export").description("Export server tools, resources, prompts, and capabilities")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => exportServerSnapshot(manager, serverId, target),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested4(result, collector, globalOptions), globalOptions.format);
  });
}
function withRpcLogsIfRequested4(value, collector, options) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }
  return attachCliRpcLogs(value, collector);
}

// src/commands/tools.ts
function registerToolsCommands(program) {
  const tools = program.command("tools").description("List and invoke MCP server tools");
  addSharedServerOptions(
    tools.command("list").description("List tools exposed by an MCP server").option("--cursor <cursor>", "Pagination cursor").option("--model-id <model>", "Model id used for token counting")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => listToolsWithMetadata(manager, {
        serverId,
        cursor: options.cursor,
        modelId: options.modelId
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested5(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    tools.command("call").description("Call an MCP tool").requiredOption("--name <tool>", "Tool name").option("--params <json>", "Tool parameter object as JSON").option(
      "--debug-out <path>",
      "Write a structured debug artifact to a file"
    )
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const primaryCollector = globalOptions.rpc || options.debugOut ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const snapshotCollector = options.debugOut ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const params = parseJsonRecord(options.params, "Tool parameters") ?? {};
    const targetSummary = summarizeServerDoctorTarget(target, config);
    let result;
    let commandError;
    try {
      result = await withEphemeralManager(
        config,
        async (manager, serverId) => ({
          status: "completed",
          result: await manager.executeTool(serverId, options.name, params)
        }),
        {
          timeout: globalOptions.timeout,
          rpcLogger: primaryCollector?.rpcLogger
        }
      );
    } catch (error) {
      commandError = error;
    }
    await writeCommandDebugArtifact({
      outputPath: options.debugOut,
      format: globalOptions.format,
      commandName: "tools call",
      commandInput: {
        toolName: options.name,
        params
      },
      target: targetSummary,
      outcome: commandError ? {
        status: "error",
        error: commandError
      } : {
        status: "success",
        result
      },
      snapshot: options.debugOut ? {
        input: {
          config,
          target: targetSummary,
          timeout: globalOptions.timeout
        },
        collector: snapshotCollector
      } : void 0,
      collectors: [primaryCollector]
    });
    if (commandError) {
      throw commandError;
    }
    writeResult(
      withRpcLogsIfRequested5(result, primaryCollector, globalOptions),
      globalOptions.format
    );
  });
}
function withRpcLogsIfRequested5(value, collector, options) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }
  return attachCliRpcLogs(value, collector);
}

// src/index.ts
async function main(argv = process.argv) {
  const program = addGlobalOptions(
    new commander.Command().name("mcpjam").description(
      "Stateless MCP server probing, debugging, OAuth login, and conformance commands backed by @mcpjam/sdk"
    ).allowExcessArguments(false).exitOverride().configureOutput({
      writeOut: (value) => process.stdout.write(value),
      writeErr: () => {
      }
    })
  );
  registerServerCommands(program);
  registerToolsCommands(program);
  registerResourcesCommands(program);
  registerPromptCommands(program);
  registerAppsCommands(program);
  registerOAuthCommands(program);
  registerProtocolCommands(program);
  if (argv.length <= 2) {
    program.outputHelp();
    return 0;
  }
  try {
    await program.parseAsync(argv);
    const exitCode = process.exitCode;
    if (typeof exitCode === "number") {
      return exitCode;
    }
    return Number(exitCode ?? 0) || 0;
  } catch (error) {
    const format = detectOutputFormatFromArgv(argv);
    if (error instanceof commander.CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }
      writeError(usageError(error.message), format);
      return 2;
    }
    const normalizedError = normalizeCliError(error);
    writeError(normalizedError, format);
    return normalizedError.exitCode;
  }
}
void main().then((exitCode) => {
  process.exitCode = exitCode;
});
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map