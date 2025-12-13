# AGENTS.md

Instructions for AI coding agents working on this codebase.

## Logging

**Do not use `console.log`, `console.warn`, or `console.error` directly.**

### Server code (`server/`)

Use the centralized logger utility:

```typescript
import { logger } from "@/utils/logger";

logger.error("Something failed", error, { userId: "123" });
logger.warn("Deprecated API used", { endpoint: "/old" });
logger.info("Server started");
logger.debug("Processing request", requestData);
```

**Why?** The logger sends errors/warnings to Sentry and respects the `--verbose` flag (silent in production by default).

### CLI script (`bin/start.js`)

Use the built-in colored logging functions:

```javascript
logSuccess("Server started"); // ✅ green
logInfo("Using port 6274"); // ℹ️  blue
logWarning("Port in use"); // ⚠️  yellow
logError("Failed to start"); // ❌ red
logStep("Build", "Compiling..."); // [Build] cyan header
logProgress("Waiting..."); // ⏳ magenta
logDivider(); // ── dim line
logBox("http://localhost:6274", "MCPJam"); // boxed output
```

For verbose-only output (hidden unless `--verbose` flag):

```javascript
verboseInfo("Loading config...");
verboseSuccess("Config loaded");
verboseStep("Setup", "Initializing...");
```

### Client code

Browser `console.*` is acceptable for client-side debugging.
