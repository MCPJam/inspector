# Use the existing mcpjam/mcp-inspector as base or build from scratch
# Multi-stage build for client and server

# Stage 1: Dependencies base (shared)
FROM node:20-slim AS deps-base
WORKDIR /app

# Copy package.json and package-lock.json files
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/package-lock.json ./sdk/
COPY evals-cli/package.json evals-cli/package-lock.json ./evals-cli/

# Install dependencies using package-lock files for consistent versions
RUN npm ci --legacy-peer-deps
RUN npm --prefix sdk ci --legacy-peer-deps
RUN npm --prefix evals-cli ci --legacy-peer-deps

# Stage 2: Build client
FROM deps-base AS client-builder
COPY shared/ ./shared/
COPY client/ ./client/
COPY tsconfig.json ./
COPY vite.renderer.config.mts ./
COPY vite.main.config.ts ./
COPY vite.preload.config.ts ./
COPY .env.production ./
# Set environment variable for Docker platform detection
ENV VITE_DOCKER=true
RUN npm run build:client

# Stage 3: Build SDK (required by server)
FROM deps-base AS sdk-builder
COPY sdk/ ./sdk/
RUN npm --prefix sdk run build

# Stage 4: Build server
FROM deps-base AS server-builder
COPY --from=sdk-builder /app/sdk/dist ./sdk/dist
COPY shared/ ./shared/
COPY evals-cli/ ./evals-cli/
COPY server/ ./server/
COPY tsconfig.json ./
RUN npm run build:server

# Stage 5: Production image - extend existing or create new
FROM node:20-slim AS production

# Build arguments for runtime configuration
ARG CONVEX_HTTP_URL
ENV CONVEX_HTTP_URL=${CONVEX_HTTP_URL}

# Install dumb-init for proper signal handling
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy built applications
COPY --from=client-builder /app/dist/client ./dist/client
COPY --from=server-builder /app/dist/server ./dist/server

# Copy built SDK (required by server at runtime)
COPY --from=sdk-builder /app/sdk/dist ./sdk/dist
COPY --from=sdk-builder /app/sdk/package.json ./sdk/package.json
COPY --from=deps-base /app/sdk/node_modules ./sdk/node_modules

# Copy public assets (logos, etc.) to be served at root level
COPY --from=client-builder /app/client/public ./public

# Copy package.json and node_modules for runtime dependencies
COPY --from=deps-base /app/package.json ./package.json
COPY --from=deps-base /app/node_modules ./node_modules

# Copy shared types
COPY shared/ ./shared/

# Copy any startup scripts
COPY bin/ ./bin/

# Create non-root user
RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home mcpjam

# Change ownership of the app directory
RUN chown -R mcpjam:nodejs /app
USER mcpjam

# Expose port
EXPOSE 3001

# Set environment variables
ENV PORT=3001
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').request('http://localhost:3001/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).end()"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application with production environment
CMD ["sh", "-c", "NODE_ENV=production node dist/server/index.js"]
