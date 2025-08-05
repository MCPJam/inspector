# Use the existing mcpjam/mcp-inspector as base or build from scratch
# Multi-stage build for client and server

# Stage 1: Build client
FROM node:18-alpine AS client-builder
WORKDIR /app
COPY client/package*.json ./client/
RUN cd client && npm install --include=dev
COPY client/ ./client/
COPY shared/ ./shared/
RUN cd client && npm run build

# Stage 2: Build server
FROM node:18-alpine AS server-builder
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm install --include=dev
COPY server/ ./server/
COPY shared/ ./shared/
RUN cd server && npm run build

# Stage 3: Production image - extend existing or create new
FROM node:18-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app directory
WORKDIR /app

# Copy built applications
COPY --from=client-builder /app/dist/client ./dist/client
COPY --from=server-builder /app/dist/server ./dist/server
COPY --from=server-builder /app/server/node_modules ./server/node_modules
COPY --from=server-builder /app/server/package.json ./server/package.json

# Copy shared types
COPY shared/ ./shared/

# Copy root package.json and any startup scripts
COPY package.json ./
COPY bin/ ./bin/

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S mcpjam -u 1001

# Change ownership of the app directory
RUN chown -R mcpjam:nodejs /app
USER mcpjam

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').request('http://localhost:3001/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).end()"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/server/index.js"] 