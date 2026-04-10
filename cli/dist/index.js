#!/usr/bin/env node
'use strict';

var commander = require('commander');
var sdk = require('@mcpjam/sdk');
var fs = require('fs');

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
function usageError(message, details) {
  return new CliError("USAGE_ERROR", message, 2, details);
}
function operationalError(message, details) {
  return new CliError("OPERATIONAL_ERROR", message, 1, details);
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
  if (value === "json" || value === "human" || value === "junit-xml") {
    return value;
  }
  throw usageError(
    `Invalid output format "${value}". Use "json", "human", or "junit-xml".`
  );
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

// src/lib/server-config.ts
function collectString(value, previous = []) {
  return [...previous, value];
}
function addSharedServerOptions(command) {
  return command.option("--url <url>", "HTTP MCP server URL").option("--access-token <token>", "Bearer access token for HTTP servers").option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    collectString,
    []
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
    format: options.format ?? "json",
    timeout: options.timeout ?? 3e4
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
    return {
      url,
      accessToken: options.accessToken,
      requestInit: headers ? { headers } : void 0,
      timeout: options.timeout
    };
  }
  if (!command) {
    throw usageError("Missing stdio command.");
  }
  if (options.accessToken || (options.header?.length ?? 0) > 0) {
    throw usageError(
      "--access-token and --header can only be used together with --url."
    );
  }
  return {
    command,
    args: parseCommandArgs(options.commandArgs),
    env: parseEnvironmentOption(options.env),
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
  ).option(
    "--format <format>",
    "Output format: json or human",
    parseOutputFormat,
    "json"
  );
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

// src/commands/oauth.ts
var DYNAMIC_CLIENT_ID_PLACEHOLDER = "__dynamic_registration_client__";
var DYNAMIC_CLIENT_SECRET_PLACEHOLDER = "__dynamic_registration_secret__";
function registerOAuthCommands(program) {
  const oauth = program.command("oauth").description("Run MCP OAuth conformance flows");
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
  ).option("--scopes <scopes>", "Space-separated scope string").option(
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
    const globalOptions = getGlobalOptions(command);
    const config = buildOAuthConformanceConfig(options);
    const result = await new sdk.OAuthConformanceTest(config).run();
    if (globalOptions.format === "junit-xml") {
      process.stdout.write(singleResultToJUnitXml(result));
    } else {
      writeResult(result, globalOptions.format);
    }
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
    const globalOptions = getGlobalOptions(command);
    const config = loadSuiteConfig(options.config);
    if (options.verifyTools || options.verifyCallTool) {
      const verification = {
        ...config.defaults?.verification,
        ...options.verifyTools ? { listTools: true } : {},
        ...options.verifyCallTool ? { callTool: { name: options.verifyCallTool } } : {}
      };
      config.defaults = { ...config.defaults, verification };
    }
    const suite = new sdk.OAuthConformanceSuite(config);
    const result = await suite.run();
    if (globalOptions.format === "junit-xml") {
      process.stdout.write(suiteResultToJUnitXml(result));
    } else {
      writeResult(result, globalOptions.format);
    }
    if (!result.passed) {
      setProcessExitCode(1);
    }
  });
}
function buildOAuthConformanceConfig(options) {
  const serverUrl = options.url.trim();
  assertValidUrl2(serverUrl, "server URL");
  const protocolVersion = parseProtocolVersion(options.protocolVersion);
  const registrationStrategy = parseRegistrationStrategy(options.registration);
  const authMode = parseAuthMode(options.authMode ?? "headless");
  if (protocolVersion !== "2025-11-25" && registrationStrategy === "cimd") {
    throw usageError(
      `CIMD registration is not supported for protocol version ${protocolVersion}.`
    );
  }
  if (authMode === "client_credentials" && registrationStrategy === "cimd") {
    throw usageError(
      "client_credentials is not supported with --registration cimd."
    );
  }
  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret;
  const clientMetadataUrl = options.clientMetadataUrl?.trim();
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
    stepTimeout: options.stepTimeout ?? 3e4,
    verification
  };
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
  if (value === "2025-03-26" || value === "2025-06-18" || value === "2025-11-25") {
    return value;
  }
  throw usageError(
    `Invalid protocol version "${value}". Use 2025-03-26, 2025-06-18, or 2025-11-25.`
  );
}
function parseRegistrationStrategy(value) {
  if (value === "cimd" || value === "dcr" || value === "preregistered") {
    return value;
  }
  throw usageError(
    `Invalid registration strategy "${value}". Use cimd, dcr, or preregistered.`
  );
}
function parseAuthMode(value) {
  if (value === "headless" || value === "interactive" || value === "client_credentials") {
    return value;
  }
  throw usageError(
    `Invalid auth mode "${value}". Use headless, interactive, or client_credentials.`
  );
}
async function withEphemeralManager(config, fn, options) {
  return sdk.withEphemeralClient(config, fn, {
    serverId: "__cli__",
    clientName: "mcpjam",
    timeout: options?.timeout ?? 3e4
  });
}

// src/commands/prompts.ts
function registerPromptCommands(program) {
  const prompts = program.command("prompts").description("List and fetch MCP prompts");
  addSharedServerOptions(
    prompts.command("list").description("List prompts exposed by an MCP server").option("--cursor <cursor>", "Pagination cursor")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.listPrompts(manager, { serverId, cursor: options.cursor }),
      { timeout: globalOptions.timeout }
    );
    writeResult(result, globalOptions.format);
  });
  addSharedServerOptions(
    prompts.command("get").description("Get a named prompt from an MCP server").requiredOption("--name <prompt>", "Prompt name").option("--prompt-args <json>", "Prompt arguments as a JSON object")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
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
      { timeout: globalOptions.timeout }
    );
    writeResult(result, globalOptions.format);
  });
}
function registerResourcesCommands(program) {
  const resources = program.command("resources").description("List and read MCP resources");
  addSharedServerOptions(
    resources.command("list").description("List resources exposed by an MCP server").option("--cursor <cursor>", "Pagination cursor")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.listResources(manager, { serverId, cursor: options.cursor }),
      { timeout: globalOptions.timeout }
    );
    writeResult(result, globalOptions.format);
  });
  addSharedServerOptions(
    resources.command("read").description("Read a resource from an MCP server").requiredOption("--uri <uri>", "Resource URI")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.readResource(manager, { serverId, uri: options.uri }),
      { timeout: globalOptions.timeout }
    );
    writeResult(result, globalOptions.format);
  });
}

// src/commands/server.ts
function registerServerCommands(program) {
  const server = program.command("server").description("Inspect MCP server connectivity and capabilities");
  addSharedServerOptions(
    server.command("info").description("Get initialization info for an MCP server")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
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
      { timeout: globalOptions.timeout }
    );
    writeResult(result, globalOptions.format);
  });
}
function registerToolsCommands(program) {
  const tools = program.command("tools").description("List and invoke MCP server tools");
  addSharedServerOptions(
    tools.command("list").description("List tools exposed by an MCP server").option("--cursor <cursor>", "Pagination cursor")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.listTools(manager, { serverId, cursor: options.cursor }),
      { timeout: globalOptions.timeout }
    );
    writeResult(result, globalOptions.format);
  });
  addSharedServerOptions(
    tools.command("call").description("Call an MCP tool").requiredOption("--name <tool>", "Tool name").option("--params <json>", "Tool parameter object as JSON")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const params = parseJsonRecord(options.params, "Tool parameters") ?? {};
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => manager.executeTool(serverId, options.name, params),
      { timeout: globalOptions.timeout }
    );
    writeResult(result, globalOptions.format);
  });
}

// src/index.ts
async function main(argv = process.argv) {
  const program = addGlobalOptions(
    new commander.Command().name("mcpjam").description(
      "Stateless MCP inspection and OAuth conformance commands backed by @mcpjam/sdk"
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
  registerOAuthCommands(program);
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
    writeError(error, format);
    return error instanceof CliError ? error.exitCode : 1;
  }
}
void main().then((exitCode) => {
  process.exitCode = exitCode;
});
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map