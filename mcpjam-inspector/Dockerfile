# Use specific Node.js version to match local/CI runtimes and dependency engines.
# 24.21 runs ahead of CI's 24.14 deliberately: its bundled npm carries the
# node-tar fix for CVE-2026-59873, and the Container Scan workflow's gate
# verifies the Debian layer on every change. UNPINNED build-time apt/npm
# upgrades are not the way to fix base-image CVEs here — Railway caches that
# layer while CI rebuilds cold, so the scanned image silently drifts from the
# deployed one. A pinned version (the perl-base step below) is deterministic
# either way. When the weekly Container Scan fails on a fixable CRITICAL from
# the base, bump this pin.
ARG NODE_VERSION=24.21.0

# Debian (glibc) base, not Alpine (musl): Playwright's Chromium is built
# against glibc and will not launch on musl. Widget-probe rendering (synthetic
# monitors + browser-render evals) needs a launchable Chromium in this image.
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /usr/src/app

# The newest node:24 bookworm-slim build ships perl-base 5.36.0-7+deb12u3,
# which carries CRITICAL CVE-2026-13221, CVE-2026-42496 and CVE-2026-8376.
# bookworm-security has the fix. Pinned, as the header above explains; the
# install fails loudly once a later security update replaces this version in
# the archive. Delete this step once the NODE_VERSION image ships deb12u4.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade perl-base=5.36.0-7+deb12u4 \
    && rm -rf /var/lib/apt/lists/*

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
COPY evaluators/package.json ./evaluators/package.json
COPY sdk/package.json ./sdk/package.json
COPY cli/package.json ./cli/package.json
COPY design-system/package.json ./design-system/package.json
COPY chat-ui/package.json ./chat-ui/package.json
COPY widget-react/package.json ./widget-react/package.json
COPY mcpjam-inspector/package.json ./mcpjam-inspector/package.json

COPY soundcheck/package.json ./soundcheck/package.json
COPY mcp/package.json ./mcp/package.json
COPY slack-app/package.json ./slack-app/package.json
COPY surface-core/package.json ./surface-core/package.json
COPY discord-app/package.json ./discord-app/package.json
COPY vitest/package.json ./vitest/package.json

RUN npm ci --legacy-peer-deps

################################################################################
# Keep test/build tools out of the shipped image while retaining workspace links.
FROM deps AS production-deps
RUN npm prune --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund

################################################################################
# Build the inspector and its workspace dependencies.
FROM deps AS build

ENV NODE_OPTIONS="--max-old-space-size=4096"

ARG VITE_MCPJAM_HOSTED_MODE
ARG VITE_ENVIRONMENT
ARG VITE_MCPJAM_NONPROD_LOCKDOWN
ARG VITE_MCPJAM_EMPLOYEE_EMAIL_DOMAINS
ARG VITE_WORKOS_API_HOSTNAME
ARG VITE_STRIPE_PUBLISHABLE_KEY
ARG VITE_CONVEX_URL
ARG VITE_WORKOS_CLIENT_ID
ARG VITE_MCPJAM_SANDBOX_ORIGIN
ARG VITE_MCPJAM_VIEW_MOUNT
ARG VITE_MCPJAM_VIEW_SUBDOMAINS
# Not a VITE_ var — it is never bundled. `sentryVitePlugin` in
# client/vite.config.ts reads it at BUILD time to upload source maps for the
# release, and without it every hosted prod stack trace stays minified
# (`index-<hash>.js:8:117100`) while Sentry falls back to scraping the asset
# URL, which the SPA answers with index.html. Absent, the plugin warns and
# skips the upload, so local and desktop builds are unaffected.
#
# ARG, and not a BuildKit secret mount, because Railway builds this image and
# does not support `--mount=type=secret`: declaring an ARG of the same name as
# a service variable is the only supported way to reach a build-time secret
# there. The exposure that buys is bounded — the ARG is scoped to this build
# stage, the token is never written to disk or promoted to ENV, and the runtime
# image below is a separate stage that copies artifacts rather than layers. It
# would surface in this stage's build history and in `mode=max` provenance,
# neither of which Railway publishes. Mark the variable Sealed in Railway so it
# is not readable back out of the dashboard or API.
ARG SENTRY_AUTH_TOKEN
# Same handling as SENTRY_AUTH_TOKEN, for `@posthog/rollup-plugin` in the same
# config: a PostHog personal API key with error tracking write. Absent, the
# plugin is disabled and PostHog exceptions stay unsymbolicated.
ARG POSTHOG_PERSONAL_API_KEY

COPY evaluators ./evaluators
RUN npm run build -w @mcpjam/evaluators

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
# This image enumerates the bundle steps instead of running `npm run build`, so
# every generated-and-gitignored module `build:server` imports has to be listed
# here by hand. `bundle:plugin-shim` emits the in-VM plugin shim as a TS const
# that `services/plugins/computer-stdio.ts` imports at top level: without it the
# server bundle does not resolve and the image fails to build.
# `bundle:codex-appserver-bridge` is the same story for the Codex app-server
# transport: its bridge and the MCP server Codex spawns are uploaded into a
# sandbox and executed there, so nothing in the import graph reaches them and
# `codex-appserver-bootstrap.ts` imports the generated const at top level.
# `bundle:local-harness-layer` likewise: the local runtime's Inspector layer
# (launcher + bridges) is a generated const `local/inspector-layer.ts` imports,
# even though a hosted server never runs a local harness.
RUN npm run bundle:chatgpt -w @mcpjam/inspector && \
    npm run bundle:mcp-apps -w @mcpjam/inspector && \
    npm run bundle:sandbox-proxies -w @mcpjam/inspector && \
    npm run bundle:plugin-shim -w @mcpjam/inspector && \
    npm run bundle:codex-appserver-bridge -w @mcpjam/inspector && \
    npm run bundle:local-harness-layer -w @mcpjam/inspector

# `bundle:browser-harness` esbuilds `server/utils/browser-harness/host-page.ts`,
# which imports `@/components/chat-v2/thread/mcp-apps/host-app-bridge` from the
# client tree. It therefore has to run AFTER `mcpjam-inspector/client` is on
# disk; `build:server` consumes the generated harness bundle so it runs in the
# same step.
# chat-ui and widget-react are aliased to their SOURCE by client/vite.config.ts
# (and Tailwind scans the same source), so they must be on disk before
# `build:client` — but they are consumed from source, so neither needs a build.
COPY design-system ./design-system
COPY chat-ui ./chat-ui
COPY widget-react ./widget-react
COPY mcpjam-inspector/client ./mcpjam-inspector/client
COPY mcpjam-inspector/.env.production ./mcpjam-inspector/
RUN npm run bundle:browser-harness -w @mcpjam/inspector && \
    npm run build:server -w @mcpjam/inspector
# MCPJAM_BUILD_SURFACE is the Sentry `dist` this bundle reports and uploads
# under. Hardcoded rather than an ARG: the web image is the only thing this
# Dockerfile builds. Without it this bundle's events resolve against the npm or
# desktop artifacts, which share the same bare `release`. See
# SENTRY_BUILD_SURFACES in shared/sentry-config.ts.
RUN if [ -n "$VITE_STRIPE_PUBLISHABLE_KEY" ]; then export VITE_STRIPE_PUBLISHABLE_KEY; fi; \
    if [ -n "$VITE_MCPJAM_HOSTED_MODE" ]; then export VITE_MCPJAM_HOSTED_MODE; fi; \
    if [ -n "$VITE_ENVIRONMENT" ]; then export VITE_ENVIRONMENT; fi; \
    if [ -n "$VITE_MCPJAM_NONPROD_LOCKDOWN" ]; then export VITE_MCPJAM_NONPROD_LOCKDOWN; fi; \
    if [ -n "$VITE_MCPJAM_EMPLOYEE_EMAIL_DOMAINS" ]; then export VITE_MCPJAM_EMPLOYEE_EMAIL_DOMAINS; fi; \
    if [ -n "$VITE_WORKOS_API_HOSTNAME" ]; then export VITE_WORKOS_API_HOSTNAME; fi; \
    if [ -n "$VITE_CONVEX_URL" ]; then export VITE_CONVEX_URL; fi; \
    if [ -n "$VITE_WORKOS_CLIENT_ID" ]; then export VITE_WORKOS_CLIENT_ID; fi; \
    if [ -n "$VITE_MCPJAM_SANDBOX_ORIGIN" ]; then export VITE_MCPJAM_SANDBOX_ORIGIN; fi; \
    if [ -n "$VITE_MCPJAM_VIEW_MOUNT" ]; then export VITE_MCPJAM_VIEW_MOUNT; fi; \
    if [ -n "$VITE_MCPJAM_VIEW_SUBDOMAINS" ]; then export VITE_MCPJAM_VIEW_SUBDOMAINS; fi; \
    if [ -n "$SENTRY_AUTH_TOKEN" ]; then export SENTRY_AUTH_TOKEN; fi; \
    if [ -n "$POSTHOG_PERSONAL_API_KEY" ]; then export POSTHOG_PERSONAL_API_KEY; fi; \
    MCPJAM_BUILD_SURFACE=web npm run build:client -w @mcpjam/inspector

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
COPY evaluators/package.json /usr/src/app/evaluators/package.json
COPY sdk/package.json /usr/src/app/sdk/package.json
COPY cli/package.json /usr/src/app/cli/package.json
COPY mcpjam-inspector/package.json ./package.json

COPY --from=production-deps /usr/src/app/node_modules /usr/src/app/node_modules
# Workspace-local deps that can't hoist to root (e.g. @workos-inc/node@^10
# while @convex-dev/workos transitively pins @workos-inc/node@^7) land under
# mcpjam-inspector/node_modules and must be carried into the runtime image.
COPY --from=production-deps /usr/src/app/mcpjam-inspector/node_modules ./node_modules

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
#
# Calls the CLI by path, not `npx playwright`: `playwright` and the dev-only
# `@playwright/test` both declare the `playwright` bin, so `npm ci` links
# `.bin/playwright` to the latter and the production-deps prune deletes that
# link along with it, leaving `npx` with "playwright: not found".
USER root
RUN node /usr/src/app/node_modules/playwright/cli.js install --with-deps chromium \
    && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
USER node

# Keep frequently changing application artifacts after the browser layer so
# source changes can reuse the expensive Chromium and system-library install.
COPY --from=build /usr/src/app/mcpjam-inspector/bin ./bin
COPY --from=build /usr/src/app/mcpjam-inspector/dist ./dist
COPY --from=build /usr/src/app/mcpjam-inspector/.env.production ./.env.production
COPY --from=build /usr/src/app/evaluators/dist /usr/src/app/evaluators/dist
COPY --from=build /usr/src/app/sdk/dist /usr/src/app/sdk/dist

EXPOSE 6274

ENTRYPOINT ["npm", "start"]
