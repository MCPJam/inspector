# Use specific Node.js version to avoid vulnerabilities in older versions
# CVE fixes require Node.js 20.20.0+ (race condition, symlink following, uncaught exception)
ARG NODE_VERSION=20.20.0

FROM node:${NODE_VERSION}-alpine AS base

# Use /usr/src/app/mcpjam-inspector as working directory to preserve sibling structure
# This matches local dev where sdk is at ../sdk relative to mcpjam-inspector
WORKDIR /usr/src/app/mcpjam-inspector

################################################################################
# Create a stage for installing production dependecies.
FROM base AS deps

# Download dependencies as a separate step to take advantage of Docker's caching.
COPY mcpjam-inspector/package.json mcpjam-inspector/package-lock.json ./
RUN npm ci --legacy-peer-deps

# SDK is at ../sdk (sibling directory) to match local dev structure
COPY sdk/package.json sdk/package-lock.json ../sdk/
RUN npm ci --legacy-peer-deps --prefix ../sdk
################################################################################
# Create a stage for building the application.
FROM deps AS build

ENV NODE_OPTIONS="--max-old-space-size=4096"

# Build-time arguments for Vite environment variables
# These are baked into the client bundle during build
# On Railway: set VITE_MCPJAM_HOSTED_MODE=true as a build-time variable
ARG VITE_MCPJAM_HOSTED_MODE
ENV VITE_MCPJAM_HOSTED_MODE=${VITE_MCPJAM_HOSTED_MODE}

ARG VITE_WORKOS_API_HOSTNAME
ENV VITE_WORKOS_API_HOSTNAME=${VITE_WORKOS_API_HOSTNAME}

ARG VITE_CONVEX_URL
ENV VITE_CONVEX_URL=${VITE_CONVEX_URL}

ARG VITE_WORKOS_CLIENT_ID
ENV VITE_WORKOS_CLIENT_ID=${VITE_WORKOS_CLIENT_ID}

# Layer 1: Copy configuration files (rarely change)
COPY mcpjam-inspector/tsconfig.json mcpjam-inspector/package.json ./
COPY mcpjam-inspector/lib/tsconfig.json mcpjam-inspector/lib/tsup.config.ts ./lib/
COPY mcpjam-inspector/server/tsconfig.json mcpjam-inspector/server/tsup.config.ts ./server/
COPY sdk/tsconfig.json sdk/tsup.config.ts sdk/package.json ../sdk/

# Layer 2: Copy static files that don't need building
COPY mcpjam-inspector/bin ./bin

# Layer 3: Copy shared code (used by all modules, changes infrequently)
COPY mcpjam-inspector/shared ./shared

# Layer 4: Build SDK first (changes infrequently, required by server and client)
COPY sdk/src ../sdk/src
RUN npm run build:sdk

# Layer 5: Build lib (changes infrequently)
COPY mcpjam-inspector/lib ./lib
RUN npm run build:lib

# Layer 6: Build server (changes moderately, depends on SDK)
COPY mcpjam-inspector/server ./server
RUN npm run build:server

# Layer 7: Build client (changes most frequently, depends on SDK and shared)
COPY mcpjam-inspector/client ./client
COPY mcpjam-inspector/.env.production ./
RUN npm run build:client

################################################################################
# Create a new stage to run the application with minimal runtime dependencies
# where the necessary files are copied from the build stage.
FROM base AS final

# Use production node environment by default.
ENV NODE_ENV=production

# Signal to server that we're in Docker (binds to 0.0.0.0 for port forwarding)
# SECURITY: Users MUST run with -p 127.0.0.1:6274:6274 to prevent network exposure
ENV DOCKER_CONTAINER=true

# Run the application as a non-root user.
USER node

# Copy package.json so that package manager commands can be used.
COPY mcpjam-inspector/package.json .
COPY sdk/package.json ../sdk/

# Copy the production dependencies from the deps stage and also
# the built application from the build stage into the image.
COPY --from=deps /usr/src/app/mcpjam-inspector/node_modules ./node_modules
COPY --from=deps /usr/src/app/sdk/node_modules ../sdk/node_modules
COPY --from=build /usr/src/app/mcpjam-inspector/bin ./bin
COPY --from=build /usr/src/app/mcpjam-inspector/dist ./dist
COPY --from=build /usr/src/app/sdk/dist ../sdk/dist
COPY --from=build /usr/src/app/mcpjam-inspector/.env.production ./.env.production

# Expose the port that the application listens on.
EXPOSE 6274

# Run the application.
ENTRYPOINT ["npm", "start"]
