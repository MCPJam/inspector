import { parseConfig, PREREGISTERED_CLIENT_ID, PREREGISTERED_CLIENT_SECRET } from "./config.js";
import { createReferenceServer } from "./http.js";

const config = parseConfig(process.argv.slice(2));
const server = createReferenceServer(config);

server.httpServer.listen(config.port, () => {
  console.log(`\nMCPJam OAuth reference server (HP-10)`);
  console.log(`  MCP endpoint : ${config.publicUrl}/mcp`);
  console.log(`  Landing page : ${config.publicUrl}/`);
  console.log(`  Capture label: ${config.label}  (dir: ${config.captureDir})`);
  console.log(`  DCR ${config.dcr ? "on" : "OFF"} · refresh ${config.refreshTokens ? "on" : "OFF"} · PKCE ${config.requirePkce ? "required" : "optional"} · resource ${config.requireResource ? "REQUIRED" : "recorded"} · access TTL ${config.accessTokenTtl}s`);
  if (config.xaaIssuer) console.log(`  XAA jwt-bearer enabled, trusted issuer: ${config.xaaIssuer}`);
  console.log(`  Preregistered client: ${PREREGISTERED_CLIENT_ID} / ${PREREGISTERED_CLIENT_SECRET}`);
  console.log(`\nSwitch client under test without restarting:`);
  console.log(`  curl -X POST ${config.publicUrl}/capture/reset -d "{\\"label\\":\\"cursor\\"}"`);
  console.log(`Write the current capture: curl -X POST ${config.publicUrl}/capture/flush\n`);
});

const shutdown = () => {
  const capture = server.currentCapture();
  if (capture.eventCount() > 0) {
    const file = capture.flush();
    console.log(`\nCapture written: ${file}`);
  }
  void server.close().finally(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
