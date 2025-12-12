# Multi-stage build for production deployment
# Matches the build process used in GitHub Actions workflow

# Stage 1: Dependencies installation
FROM node:20-slim AS deps
WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/package-lock.json ./sdk/

# Install dependencies (using --legacy-peer-deps to handle peer dependency conflicts)
# Combine into single RUN to reduce layers and improve caching
RUN npm ci --legacy-peer-deps && \
    npm --prefix sdk ci --legacy-peer-deps

# Stage 2: Build all artifacts
FROM deps AS builder
WORKDIR /app

# Set environment variables for build (before copying source for better caching)
ENV VITE_DOCKER=true
ENV NODE_OPTIONS="--max-old-space-size=4096"
ENV NODE_ENV=production

# Copy source files needed for build
# Order by change frequency: config files first, then source code
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY lib/ ./lib/
COPY sdk/ ./sdk/
COPY server/ ./server/
COPY client/ ./client/
# .env.production is only needed at runtime, not during build
# (removed from builder stage - will be copied in production stage)

# Run the full build process (matches npm run build)
RUN npm run build

# Stage 3: Production runtime
FROM node:20-slim AS production

# Build arguments for runtime configuration
ARG CONVEX_HTTP_URL
ENV CONVEX_HTTP_URL=${CONVEX_HTTP_URL}

# Install dumb-init for proper signal handling
# Cache apt packages by doing update separately (only invalidates when package list changes)
RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user (before copying files to set ownership during copy)
RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home mcpjam

# Create app directory
WORKDIR /app

# Copy built artifacts with correct ownership (avoids slow chown -R on large dirs)
COPY --from=builder --chown=mcpjam:nodejs /app/dist ./dist

# Copy SDK dist and package.json (required at runtime)
COPY --from=builder --chown=mcpjam:nodejs /app/sdk/dist ./sdk/dist
COPY --from=builder --chown=mcpjam:nodejs /app/sdk/package.json ./sdk/package.json

# Copy runtime dependencies with correct ownership
# Using --chown here is critical - node_modules can have 50k+ files!
COPY --from=deps --chown=mcpjam:nodejs /app/package.json ./package.json
COPY --from=deps --chown=mcpjam:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=mcpjam:nodejs /app/sdk/node_modules ./sdk/node_modules

# Copy shared types and startup script
COPY --chown=mcpjam:nodejs shared/ ./shared/
COPY --chown=mcpjam:nodejs bin/ ./bin/
# Copy .env.production for runtime (not needed during build)
COPY --chown=mcpjam:nodejs .env.production ./

# Switch to non-root user (no chown needed - files already have correct ownership)
USER mcpjam

# Expose port
EXPOSE 6274

# Set environment variables
ENV PORT=6274
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').request('http://localhost:6274/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).end()"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application using npm start (matches GitHub workflow)
CMD ["npm", "start"]