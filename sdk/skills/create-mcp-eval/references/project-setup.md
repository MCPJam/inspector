## 2. Project Setup

Generate the following scaffold when creating a new eval project. Use the test runner chosen in `SKILL.md` §1 (detect from the repo; fall back to Vitest) — the examples below show both Vitest and Jest variants.

### package.json (essentials)
```json
{
  "name": "my-server-evals",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@mcpjam/sdk": "latest",
    "vitest": "^3.0.0",
    "typescript": "^5.0.0"
  }
}
```

For Jest, replace the scripts and devDependencies:
```json
{
  "scripts": {
    "test": "jest --runInBand"
  },
  "devDependencies": {
    "@mcpjam/sdk": "latest",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "@types/jest": "^29.0.0",
    "typescript": "^5.0.0"
  }
}
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "skipLibCheck": true
  },
  "include": ["tests/**/*.ts"]
}
```

### .env.example
```bash
# LLM provider key (required for LLM tests)
{LLM_ENV_VAR}={LLM_KEY_EXAMPLE}
EVAL_MODEL={LLM_MODEL}

# MCP server connection
MCP_SERVER_URL=https://your-server.example.com/sse
# For OAuth-protected servers:
# MCP_REFRESH_TOKEN=...
# MCP_CLIENT_ID=...
# MCP_CLIENT_SECRET=...

# Save eval results to MCPJam (optional)
# MCPJAM_API_KEY=sk_...
# MCPJAM_PROJECT_ID=<project id>  # optional; defaults to your org’s Default project
```

### .gitignore additions
```
node_modules/
dist/
.env
```

---
