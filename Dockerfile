# Use the existing mcpjam/mcp-inspector as base or build from scratch
# Multi-stage build for client and server

# Stage 1: Dependencies base (shared)
FROM node:20-alpine AS deps-base
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package*.json ./client/
COPY server/package*.json ./server/
RUN npm install --include=dev
RUN cd client && npm install --include=dev  
RUN cd server && npm install --include=dev

# Stage 2: Build client
FROM deps-base AS client-builder
COPY shared/ ./shared/
COPY client/ ./client/
COPY .env.production ./
RUN cd client && npm run build

# Stage 3: Build server  
FROM deps-base AS server-builder
COPY shared/ ./shared/
COPY server/ ./server/
COPY client/ ./client/
RUN cd server && npm run build

# Stage 4: Production image - extend existing or create new
FROM node:20-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app directory
WORKDIR /app

# Copy built applications
COPY --from=client-builder /app/dist/client ./dist/client
COPY --from=server-builder /app/dist/server ./dist/server

# Copy package.json files for dependencies
COPY --from=deps-base /app/package.json ./package.json
COPY --from=deps-base /app/server/package.json ./server/package.json

# Install production dependencies from root package.json (includes external packages like fix-path)
RUN npm install --production

# Copy shared types
COPY shared/ ./shared/

# Copy any startup scripts
COPY bin/ ./bin/

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S mcpjam -u 1001

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