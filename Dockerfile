# Use the existing mcpjam/mcp-inspector as base or build from scratch
# Multi-stage build for client and server

# Stage 1: Build client
FROM node:20-alpine AS client-builder
WORKDIR /app
COPY client/package*.json ./client/
RUN cd client && npm install --include=dev
COPY client/ ./client/
COPY shared/ ./shared/
RUN cd client && npm run build

# Stage 2: Build server
FROM node:20-alpine AS server-builder
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm install --include=dev
COPY server/ ./server/
COPY shared/ ./shared/
RUN cd server && npm run build

# Stage 3: Production image - extend existing or create new
FROM node:20-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app directory
WORKDIR /app

# Copy built applications
COPY --from=client-builder /app/dist/client ./dist/client
COPY --from=server-builder /app/dist/server ./dist/server

# Copy server package.json and install production dependencies at root
COPY --from=server-builder /app/server/package.json ./package.json
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

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').request('http://localhost:3001/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).end()"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application with production environment
CMD ["sh", "-c", "NODE_ENV=production node dist/server/index.cjs"] 