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

---

## Testing

**All changes should include tests.** Uses Vitest. Run with `npm run test` (or `test:watch`, `test:coverage`).

### Structure

Tests live in `__tests__/` directories next to source files. Use existing tests as examples:
- **Components**: `client/src/components/*/__tests__/*.test.tsx`
- **State**: `client/src/state/__tests__/app-reducer.test.ts`
- **Server routes**: `server/routes/mcp/__tests__/*.test.ts`
- **Utilities**: `shared/__tests__/*.test.ts`

### Key Resources

- **Factories** (`client/src/test/factories.ts`): `createServer()`, `createTool()`, `createMany()`, etc.
- **Mock presets** (`client/src/test/mocks/`): `mcpApiPresets`, `storePresets`
- **Server helpers** (`server/routes/mcp/__tests__/helpers/`): `createTestApp()`, `createMockMcpClientManager()`, `postJson()`, `expectError()`

### Checklist

Cover: happy path, validation errors, error handling, edge cases (null, empty, etc.).
