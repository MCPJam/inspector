ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-alpine AS base

WORKDIR /usr/src/app

################################################################################
# Create a stage for installing production dependecies.
FROM base AS deps

# Download dependencies as a separate step to take advantage of Docker's caching.
# Leverage a cache mount to /root/.npm to speed up subsequent builds.
# Leverage bind mounts to package.json and package-lock.json to avoid having to copy them
# into this layer.
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps

RUN --mount=type=bind,source=sdk/package.json,target=sdk/package.json \
    --mount=type=bind,source=sdk/package-lock.json,target=sdk/package-lock.json \
    --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps --prefix sdk
################################################################################
# Create a stage for building the application.
FROM deps AS build

ENV NODE_OPTIONS="--max-old-space-size=4096"

# Layer 1: Copy configuration files (rarely change)
COPY tsconfig.json package.json ./
COPY lib/tsconfig.json lib/tsup.config.ts ./lib/
COPY server/tsconfig.json server/tsup.config.ts ./server/
COPY sdk/tsconfig.json sdk/tsup.config.ts sdk/package.json ./sdk/

# Layer 2: Copy static files that don't need building
COPY bin ./bin

# Layer 3: Copy shared code (used by all modules, changes infrequently)
COPY shared ./shared

# Layer 4: Build SDK first (changes infrequently, required by server and client)
COPY sdk/src ./sdk/src
RUN npm run build:sdk

# Layer 5: Build lib (changes infrequently)
COPY lib ./lib
RUN npm run build:lib

# Layer 6: Build server (changes moderately, depends on SDK)
COPY server ./server
RUN npm run build:server

# Layer 7: Build client (changes most frequently, depends on SDK and shared)
COPY client ./client
COPY .env.production ./
RUN npm run build:client

################################################################################
# Create a new stage to run the application with minimal runtime dependencies
# where the necessary files are copied from the build stage.
FROM base AS final

# Use production node environment by default.
ENV NODE_ENV production

# Run the application as a non-root user.
USER node

# Copy package.json so that package manager commands can be used.
COPY package.json .
COPY sdk/package.json ./sdk/

# Copy the production dependencies from the deps stage and also
# the built application from the build stage into the image.
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=deps /usr/src/app/sdk/node_modules ./sdk/node_modules
COPY --from=build /usr/src/app/bin ./bin
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/sdk/dist ./sdk/dist
COPY --from=build /usr/src/app/.env.production ./.env.production

# Expose the port that the application listens on.
EXPOSE 6274

# Run the application.
ENTRYPOINT ["npm", "start"]
