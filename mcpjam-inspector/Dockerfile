# Use specific Node.js version to match local/CI runtimes and dependency engines
ARG NODE_VERSION=24.14.0

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /usr/src/app

################################################################################
# Install workspace dependencies with a single root lockfile.
FROM base AS deps

COPY package.json package-lock.json ./
COPY sdk/package.json ./sdk/package.json
COPY cli/package.json ./cli/package.json
COPY mcpjam-inspector/package.json ./mcpjam-inspector/package.json

RUN npm ci --legacy-peer-deps

################################################################################
# Build the inspector and its workspace dependencies.
FROM deps AS build

ENV NODE_OPTIONS="--max-old-space-size=4096"

ARG VITE_MCPJAM_HOSTED_MODE
ARG VITE_MCPJAM_NONPROD_LOCKDOWN
ARG VITE_MCPJAM_EMPLOYEE_EMAIL_DOMAINS
ARG VITE_WORKOS_API_HOSTNAME
ARG VITE_CONVEX_URL
ARG VITE_WORKOS_CLIENT_ID

COPY sdk/tsconfig.json sdk/tsup.config.ts sdk/package.json ./sdk/
COPY cli/package.json ./cli/package.json
COPY mcpjam-inspector/tsconfig.json mcpjam-inspector/package.json ./mcpjam-inspector/
COPY mcpjam-inspector/lib/tsconfig.json mcpjam-inspector/lib/tsup.config.ts ./mcpjam-inspector/lib/
COPY mcpjam-inspector/server/tsconfig.json mcpjam-inspector/server/tsup.config.ts ./mcpjam-inspector/server/
COPY mcpjam-inspector/bin ./mcpjam-inspector/bin
COPY mcpjam-inspector/shared ./mcpjam-inspector/shared

COPY sdk/src ./sdk/src
COPY sdk/skills ./sdk/skills
COPY sdk/scripts ./sdk/scripts
RUN npm run build -w @mcpjam/sdk

COPY mcpjam-inspector/lib ./mcpjam-inspector/lib
RUN npm run build:lib -w @mcpjam/inspector

COPY mcpjam-inspector/server ./mcpjam-inspector/server
COPY mcpjam-inspector/scripts ./mcpjam-inspector/scripts
RUN npm run bundle:chatgpt -w @mcpjam/inspector && \
    npm run bundle:mcp-apps -w @mcpjam/inspector && \
    npm run bundle:sandbox-proxies -w @mcpjam/inspector && \
    npm run build:server -w @mcpjam/inspector

COPY mcpjam-inspector/client ./mcpjam-inspector/client
COPY mcpjam-inspector/.env.production ./mcpjam-inspector/
RUN if [ -n "$VITE_MCPJAM_HOSTED_MODE" ]; then export VITE_MCPJAM_HOSTED_MODE; fi; \
    if [ -n "$VITE_MCPJAM_NONPROD_LOCKDOWN" ]; then export VITE_MCPJAM_NONPROD_LOCKDOWN; fi; \
    if [ -n "$VITE_MCPJAM_EMPLOYEE_EMAIL_DOMAINS" ]; then export VITE_MCPJAM_EMPLOYEE_EMAIL_DOMAINS; fi; \
    if [ -n "$VITE_WORKOS_API_HOSTNAME" ]; then export VITE_WORKOS_API_HOSTNAME; fi; \
    if [ -n "$VITE_CONVEX_URL" ]; then export VITE_CONVEX_URL; fi; \
    if [ -n "$VITE_WORKOS_CLIENT_ID" ]; then export VITE_WORKOS_CLIENT_ID; fi; \
    npm run build:client -w @mcpjam/inspector

################################################################################
# Runtime image.
FROM base AS final

ENV NODE_ENV=production
ENV DOCKER_CONTAINER=true

USER node
WORKDIR /usr/src/app/mcpjam-inspector

COPY package.json /usr/src/app/package.json
COPY sdk/package.json /usr/src/app/sdk/package.json
COPY mcpjam-inspector/package.json ./package.json

COPY --from=deps /usr/src/app/node_modules /usr/src/app/node_modules
COPY --from=build /usr/src/app/mcpjam-inspector/bin ./bin
COPY --from=build /usr/src/app/mcpjam-inspector/dist ./dist
COPY --from=build /usr/src/app/mcpjam-inspector/.env.production ./.env.production
COPY --from=build /usr/src/app/sdk/dist /usr/src/app/sdk/dist

EXPOSE 6274

ENTRYPOINT ["npm", "start"]
