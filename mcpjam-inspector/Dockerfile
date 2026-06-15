# Use specific Node.js version to match local/CI runtimes and dependency engines
ARG NODE_VERSION=24.14.0

# Debian (glibc) base, not Alpine (musl): Playwright's Chromium is built
# against glibc and will not launch on musl. Widget-probe rendering (synthetic
# monitors + browser-render evals) needs a launchable Chromium in this image.
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /usr/src/app

################################################################################
# Install workspace dependencies with a single root lockfile.
FROM base AS deps

# The `playwright` package's postinstall would pull Chromium into this layer,
# but the runtime image installs its own copy (final stage) into a known,
# COPY-free location — so skip the duplicate download here. This also keeps
# `npm ci` from failing in build environments that don't allowlist
# cdn.playwright.dev; only the explicit install in the final stage needs it.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
COPY sdk/package.json ./sdk/package.json
COPY cli/package.json ./cli/package.json
COPY design-system/package.json ./design-system/package.json
COPY chat-ui/package.json ./chat-ui/package.json
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
ARG VITE_MCPJAM_SANDBOX_ORIGIN

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
    npm run bundle:sandbox-proxies -w @mcpjam/inspector

# `bundle:browser-harness` esbuilds `server/utils/browser-harness/host-page.ts`,
# which imports `@/components/chat-v2/thread/mcp-apps/host-app-bridge` from the
# client tree. It therefore has to run AFTER `mcpjam-inspector/client` is on
# disk; `build:server` consumes the generated harness bundle so it runs in the
# same step.
COPY design-system ./design-system
# The inspector client aliases `@mcpjam/chat-ui` to `../chat-ui/src/index.ts`
# (see client/vite.config.ts) and Tailwind scans the same source, so the
# chat-ui workspace must be on disk before `build:client` runs. It is consumed
# from source, not from a built dist, so no chat-ui build step is needed.
COPY chat-ui ./chat-ui
COPY mcpjam-inspector/client ./mcpjam-inspector/client
COPY mcpjam-inspector/.env.production ./mcpjam-inspector/
RUN npm run bundle:browser-harness -w @mcpjam/inspector && \
    npm run build:server -w @mcpjam/inspector
RUN if [ -n "$VITE_MCPJAM_HOSTED_MODE" ]; then export VITE_MCPJAM_HOSTED_MODE; fi; \
    if [ -n "$VITE_MCPJAM_NONPROD_LOCKDOWN" ]; then export VITE_MCPJAM_NONPROD_LOCKDOWN; fi; \
    if [ -n "$VITE_MCPJAM_EMPLOYEE_EMAIL_DOMAINS" ]; then export VITE_MCPJAM_EMPLOYEE_EMAIL_DOMAINS; fi; \
    if [ -n "$VITE_WORKOS_API_HOSTNAME" ]; then export VITE_WORKOS_API_HOSTNAME; fi; \
    if [ -n "$VITE_CONVEX_URL" ]; then export VITE_CONVEX_URL; fi; \
    if [ -n "$VITE_WORKOS_CLIENT_ID" ]; then export VITE_WORKOS_CLIENT_ID; fi; \
    if [ -n "$VITE_MCPJAM_SANDBOX_ORIGIN" ]; then export VITE_MCPJAM_SANDBOX_ORIGIN; fi; \
    npm run build:client -w @mcpjam/inspector

################################################################################
# Runtime image.
FROM base AS final

ENV NODE_ENV=production
ENV DOCKER_CONTAINER=true
# Shared, predictable browser location: the `playwright install` step below
# writes Chromium here, and the harness's chromium.executablePath() resolves
# against it at runtime. Both must point at the same directory.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

USER node
WORKDIR /usr/src/app/mcpjam-inspector

COPY package.json /usr/src/app/package.json
COPY sdk/package.json /usr/src/app/sdk/package.json
COPY cli/package.json /usr/src/app/cli/package.json
COPY mcpjam-inspector/package.json ./package.json

COPY --from=deps /usr/src/app/node_modules /usr/src/app/node_modules
# Workspace-local deps that can't hoist to root (e.g. @workos-inc/node@^10
# while @convex-dev/workos transitively pins @workos-inc/node@^7) land under
# mcpjam-inspector/node_modules and must be carried into the runtime image.
COPY --from=deps /usr/src/app/mcpjam-inspector/node_modules ./node_modules
COPY --from=build /usr/src/app/mcpjam-inspector/bin ./bin
COPY --from=build /usr/src/app/mcpjam-inspector/dist ./dist
COPY --from=build /usr/src/app/mcpjam-inspector/.env.production ./.env.production
COPY --from=build /usr/src/app/sdk/dist /usr/src/app/sdk/dist

# Bake in Chromium + its system libraries — the same command CI runs
# (test.yml) — so widget probes render at runtime instead of recording
# `browser_unavailable`. Runs as root because `--with-deps` apt-installs the
# shared libraries Chromium needs; installs the browser into
# PLAYWRIGHT_BROWSERS_PATH and makes it readable + executable by the
# unprivileged `node` user, then drops privileges back.
#
# Build-time egress required: cdn.playwright.dev (browser binary) and the
# Debian apt mirrors (--with-deps system libs). If the build environment
# blocks cdn.playwright.dev this step is where it fails — loudly, by design.
USER root
RUN npx playwright install --with-deps chromium \
    && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
USER node

EXPOSE 6274

ENTRYPOINT ["npm", "start"]
