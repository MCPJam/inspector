ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-alpine as base

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

# Copy the rest of the source files into the image.
COPY . .

ENV NODE_OPTIONS="--max-old-space-size=4096"

# Run the build script.
RUN npm run build

################################################################################
# Create a new stage to run the application with minimal runtime dependencies
# where the necessary files are copied from the build stage.
FROM base as final

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

# Expose the port that the application listens on.
EXPOSE 6274

# Run the application.
CMD npm start
