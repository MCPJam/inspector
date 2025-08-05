# MCP Inspector Migration: Next.js to Hono + Vite

## Executive Summary

This document outlines the migration of MCP Inspector from Next.js to Hono + Vite architecture to achieve better performance, reduced bundle size, enhanced desktop compatibility, and simplified deployment for NPX distribution.

## 1. Why We're Making This Change

### Current Pain Points with Next.js

- **Bundle Size**: Next.js adds ~15MB+ overhead for a simple MCP inspector tool
- **Desktop Limitations**: Server-side rendering creates complexity for future Electron integration
- **Development Complexity**: Full-stack framework overkill for a lightweight inspector tool
- **NPX Distribution**: Heavy dependencies impact cold-start performance

### Benefits of Hono + Vite Migration

- **Lightweight**: 50KB runtime vs Next.js 15MB+ overhead
- **Desktop Ready**: Client-server separation enables easier Electron migration
- **Universal Compatibility**: Hono runs on Node.js, Bun, Deno, edge runtimes
- **Better DX**: TypeScript-first with excellent tooling
- **Performance**: 3x faster cold starts, better resource utilization
- **Future-Proof**: Clear path to desktop app with Tauri/Electron

## 2. Current Architecture Analysis

### Next.js Structure

```
src/
├── app/
│   ├── api/
│   │   └── mcp/
│   │       ├── chat/route.ts          # SSE streaming chat
│   │       ├── connect/route.ts       # MCP server validation
│   │       ├── prompts/               # MCP prompt management
│   │       ├── resources/             # MCP resource handling
│   │       └── tools/route.ts         # MCP tool discovery
│   ├── page.tsx                       # Main app page
│   └── layout.tsx                     # Root layout
├── components/                        # 70+ React components
├── lib/                              # Utilities and types
└── hooks/                            # Custom React hooks
```

### Key API Endpoints

1. **POST /api/mcp/chat** - SSE streaming chat with MCP tool integration
2. **POST /api/mcp/connect** - Server connection validation
3. **GET /api/mcp/tools** - Tool discovery and listing
4. **GET /api/mcp/resources/list** - Resource enumeration
5. **POST /api/mcp/resources/read** - Resource content retrieval
6. **GET /api/mcp/prompts/list** - Prompt template listing

### Dependencies Analysis

- **Core MCP**: @mastra/core, @mastra/mcp
- **AI Providers**: @ai-sdk/anthropic, @ai-sdk/openai, ollama-ai-provider
- **UI Framework**: React 19, Tailwind CSS, Radix UI
- **State Management**: Zustand, @tanstack/react-query

## 3. Target Architecture: Hono + Vite

### New Structure (Single Repository, Unified Package)

```
mcpjam-inspector/
├── server/
│   ├── index.ts                      # Hono app entry point
│   ├── routes/
│   │   ├── mcp/
│   │   │   ├── chat.ts              # Chat SSE endpoint
│   │   │   ├── connect.ts           # Connection validation
│   │   │   ├── prompts.ts           # Prompt management
│   │   │   ├── resources.ts         # Resource handling
│   │   │   └── tools.ts             # Tool discovery
│   │   └── static.ts                # Static file serving
│   ├── middleware/
│   │   ├── cors.ts                  # CORS configuration
│   │   ├── logger.ts                # Request logging
│   │   └── error.ts                 # Error handling
│   └── utils/
│       ├── mcp-client.ts            # MCP client utilities
│       └── streaming.ts             # SSE utilities
├── client/
│   ├── src/
│   │   ├── components/              # Existing React components
│   │   ├── lib/                     # Client-side utilities
│   │   ├── hooks/                   # React hooks
│   │   └── main.tsx                 # Vite entry point
│   ├── index.html                   # HTML template
│   └── vite.config.ts              # Vite configuration
├── shared/
│   └── types.ts                     # Shared TypeScript types
├── dist/                            # Built assets (client + server)
├── bin/
│   └── start.js                     # Updated NPX entry point
├── package.json                     # Single unified package
└── tsconfig.json                    # Shared TypeScript config
```

### Repository Strategy: Single Package Distribution

**Why NOT a monorepo:**

- **NPX Simplicity**: Single `npx @mcpjam/inspector` command
- **Atomic Updates**: Client/server versions always synchronized
- **Reduced Complexity**: One `package.json`, unified build process
- **Smaller Bundle**: No duplicate dependencies between packages
- **User Experience**: Simple installation, no package coordination

**Package.json Structure:**

```json
{
  "name": "@mcpjam/inspector",
  "version": "0.8.2",
  "bin": { "inspector-v1": "bin/start.js" },
  "files": ["bin", "dist", "package.json"],
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "build": "npm run build:client && npm run build:server",
    "dev:server": "tsx watch server/index.ts",
    "dev:client": "vite client/ --port 5173",
    "build:client": "vite build client/ --outDir ../dist/client",
    "build:server": "tsup server/index.ts --outDir dist/server"
  }
}
```

### Technology Stack

- **Backend**: Hono + Node.js (with Bun upgrade path)
- **Frontend**: Vite + React + TypeScript
- **Styling**: Tailwind CSS (maintained)
- **State Management**: Zustand + TanStack Query (maintained)
- **UI Components**: Radix UI (maintained)
- **Distribution**: NPX with unified binary

### API Mapping

| Next.js Route          | Hono Route              | Notes                    |
| ---------------------- | ----------------------- | ------------------------ |
| `/api/mcp/chat`        | `POST /api/mcp/chat`    | SSE streaming maintained |
| `/api/mcp/connect`     | `POST /api/mcp/connect` | Direct port              |
| `/api/mcp/tools`       | `GET /api/mcp/tools`    | Direct port              |
| `/api/mcp/resources/*` | `/api/mcp/resources/*`  | Direct port              |
| `/api/mcp/prompts/*`   | `/api/mcp/prompts/*`    | Direct port              |

## 4. Migration Plan

_Note: This migration plan is designed for flexible, personal development pace. Complete phases as time permits._

### Phase 1: Foundation Setup

**Goal**: Establish new project structure and basic configuration  
**Time Commitment**: ~4-6 hours across multiple sessions

- [ ] Create new project structure with Hono + Vite
- [ ] Set up TypeScript configuration for both client/server
- [ ] Configure Vite build with HMR for development
- [ ] Create Hono app with basic routing structure
- [ ] Set up shared types between client/server

### Phase 2: Backend Migration - Simple Endpoints

**Goal**: Port straightforward MCP endpoints  
**Time Commitment**: ~6-8 hours across multiple sessions

- [ ] Port MCP client utilities from Next.js to Hono
- [ ] Migrate `/api/mcp/connect` endpoint (simplest first)
- [ ] Migrate `/api/mcp/tools` endpoint
- [ ] Migrate `/api/mcp/resources/*` endpoints
- [ ] Migrate `/api/mcp/prompts/*` endpoints

### Phase 3: Chat Streaming Migration (Most Complex)

**Goal**: Port the complex chat streaming functionality  
**Time Commitment**: ~8-12 hours (spread across sessions)

- [ ] Port complex `/api/mcp/chat` SSE streaming logic
- [ ] Implement elicitation handling in Hono
- [ ] Test tool call streaming and real-time events
- [ ] Verify MCP client lifecycle management

### Phase 4: Frontend Integration

**Goal**: Move React app to Vite and connect to new backend  
**Time Commitment**: ~6-8 hours across multiple sessions

- [ ] Move React components to Vite structure
- [ ] Update API client calls to new Hono endpoints
- [ ] Configure Vite dev proxy to Hono server
- [ ] Update state management and data fetching

### Phase 5: Static Assets & Production Build

**Goal**: Handle static files and create production builds  
**Time Commitment**: ~4-6 hours across multiple sessions

- [ ] Configure Hono static file serving
- [ ] Set up client-side routing with React Router
- [ ] Handle SPA fallback for browser history
- [ ] Optimize asset bundling and code splitting

### Phase 6: NPX Integration & Final Polish

**Goal**: Update distribution and ensure everything works end-to-end  
**Time Commitment**: ~4-6 hours across multiple sessions

- [ ] Update `bin/start.js` to launch unified Hono server (serves both API + static)
- [ ] Configure production builds: `dist/server.js` + `dist/client/` assets
- [ ] Update package.json with unified build scripts and file includes
- [ ] Test NPX distribution with new single-package architecture
- [ ] Add graceful startup/shutdown handling
- [ ] Comprehensive testing of all MCP functionality
- [ ] Performance benchmarking vs Next.js version

**Key NPX Changes:**

```javascript
// bin/start.js - simplified approach
const server = spawn("node", ["dist/server.js"], {
  env: { ...process.env, NODE_ENV: "production" },
});
// Hono server serves both API routes AND static client files
```

## 5. Technical Implementation Details

### Hono Server Setup

```typescript
// server/index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/node-server/serve-static";

import mcpRoutes from "./routes/mcp";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());

// API Routes
app.route("/api/mcp", mcpRoutes);

// Static file serving
app.use("/*", serveStatic({ root: "./dist/client" }));

// SPA fallback
app.get("*", serveStatic({ path: "./dist/client/index.html" }));

export default app;
```

### MCP Chat Streaming in Hono

```typescript
// server/routes/mcp/chat.ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const chat = new Hono();

chat.post("/", async (c) => {
  const { serverConfigs, model, messages } = await c.req.json();

  return streamSSE(c, async (stream) => {
    // Port existing MCP client logic
    const client = createMCPClientWithMultipleConnections(serverConfigs);
    const tools = await client.getTools();

    // Stream tool calls and results
    const agent = new Agent({ model, tools });
    const result = await agent.stream(messages);

    for await (const chunk of result.textStream) {
      await stream.writeSSE({
        data: JSON.stringify({ type: "text", content: chunk }),
      });
    }

    await stream.writeSSE({ data: "[DONE]" });
  });
});

export default chat;
```

### Vite Configuration

```typescript
// client/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
```

## 6. Risk Assessment & Mitigation

### High Risk Areas

1. **SSE Streaming Complexity**
   - _Risk_: Chat streaming logic is complex with tool calls and elicitation
   - _Mitigation_: Port incrementally, extensive testing, fallback mechanisms

2. **MCP Client Lifecycle**
   - _Risk_: Connection management and cleanup in Hono vs Next.js
   - _Mitigation_: Create abstraction layer, monitor connection leaks

3. **State Synchronization**
   - _Risk_: Client-server state management with separate processes
   - _Mitigation_: Keep existing React state management, update API layer only

### Medium Risk Areas

1. **Static Asset Loading**
   - _Risk_: Different asset handling between Next.js and Vite
   - _Mitigation_: Test thoroughly, use Vite asset optimization

2. **NPX Distribution Changes**
   - _Risk_: Breaking changes to user installation flow
   - _Mitigation_: Maintain backward compatibility, clear migration docs

### Low Risk Areas

1. **UI Component Migration** - Direct port with minimal changes
2. **TypeScript Configuration** - Similar setup between frameworks
3. **Development Experience** - Improved with Vite HMR

## 7. Success Metrics

### Performance Targets

- **Bundle Size**: < 5MB total (vs current ~20MB)
- **Cold Start**: < 2s (vs current ~5s)
- **Memory Usage**: < 100MB (vs current ~200MB)
- **Build Time**: < 30s (vs current ~60s)

### Functional Requirements

- [ ] All existing MCP functionality preserved
- [ ] Chat streaming performance maintained
- [ ] Tool call execution works identically
- [ ] Server connection management stable
- [ ] NPX installation seamless

### Quality Gates

- [ ] Zero regression in MCP protocol compatibility
- [ ] TypeScript coverage maintained (>90%)
- [ ] All existing tests passing
- [ ] Performance benchmarks met
- [ ] Security audit passed

## 8. Future Considerations

### Desktop App Migration Path

With the new client-server separation:

1. **Tauri Integration**: Replace Hono server with Tauri backend
2. **Electron Option**: Package as Electron app with embedded server
3. **Native Features**: File system access, native notifications

### Runtime Flexibility

- **Bun Migration**: Easy upgrade path from Node.js to Bun
- **Edge Deployment**: Hono supports Cloudflare Workers, Vercel Edge
- **Container Deployment**: Simplified Docker packaging

### Extensibility

- **Plugin System**: Hono middleware for custom MCP extensions
- **Theme Engine**: Easier customization with Vite builds
- **Multi-Protocol**: Foundation for other protocol inspectors

## 9. Flexible Implementation Approach

### Total Time Commitment

**~32-46 hours** spread across 6 phases at your own pace

### Phase Priority Recommendations

1. **Start with Phase 1 & 2** - Gets you a working backend quickly
2. **Phase 3 is the hardest** - Tackle when you have longer uninterrupted time
3. **Phase 4-6 are incremental** - Can be done in smaller chunks

### Suggested Session Breakdown

- **Short sessions (1-2 hours)**: Foundation work, simple endpoint ports, config
- **Medium sessions (2-4 hours)**: Frontend integration, static assets
- **Long sessions (4+ hours)**: Chat streaming migration (Phase 3)

### Milestone Checkpoints

- **After Phase 2**: Working API server with basic MCP functionality
- **After Phase 4**: Full-stack app running in development
- **After Phase 6**: Production-ready NPX distribution

## 10. Conclusion

The migration from Next.js to Hono + Vite will deliver:

- **75% reduction** in bundle size
- **60% improvement** in cold-start performance
- **Clear path** to desktop application
- **Enhanced developer experience** with better tooling
- **Future-proof architecture** with runtime flexibility

This migration positions MCP Inspector as a lightweight, performant tool while maintaining all existing functionality and providing a foundation for future enhancements.
