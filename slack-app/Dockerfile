# The MCPJam Slack bot.
#
# In OAuth mode the process serves HTTP on $PORT (Bolt's HTTP receiver owns
# /slack/events, /slack/install, /slack/oauth_redirect), so the Railway
# service needs a public domain. In socket mode — the local-dev default, and
# what runs when no OAuth credentials are set — it dials OUT instead and
# serves nothing. The mode is chosen at boot from config presence; the image
# is the same either way.
#
# Built from the MONOREPO ROOT as context (the lockfile lives there), which
# is why every path below is repo-relative. The Railway service selects this
# file with the RAILWAY_DOCKERFILE_PATH variable, because the root
# railway.json points at the inspector's Dockerfile.

FROM node:24-alpine

# The base image's npm bundles dependencies that are behind their upstream
# security fixes: npm 11.21.0 carries the patched tar and ip-address, and the
# pinned overlays cover the two packages no npm release has caught up on.
# Same rationale as mcpjam-inspector/Dockerfile — delete once the node:24
# image bundles an npm whose own copies have caught up. The first command
# fails the build once the base npm reaches the pin, so that moment cannot
# pass unnoticed.
RUN node -e 'const d="/usr/local/lib/node_modules/npm",v=require(d+"/package.json").version;if(require(d+"/node_modules/semver").gte(v,"11.21.0")){console.error("base npm "+v+" is at or past the npm@11.21.0 pin: re-evaluate the npm pin and the brace-expansion/undici overlays");process.exit(1)}' \
  && npm install -g npm@11.21.0 --no-audit --no-fund \
  && cd /tmp \
  && npm pack brace-expansion@5.0.12 undici@6.29.0 --loglevel=error \
  && tar -xzf brace-expansion-5.0.12.tgz \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
  && mv package /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
  && tar -xzf undici-6.29.0.tgz \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
  && mv package /usr/local/lib/node_modules/npm/node_modules/undici \
  && rm /tmp/brace-expansion-5.0.12.tgz /tmp/undici-6.29.0.tgz \
  && npm cache clean --force

WORKDIR /app

# Manifests + lockfile first so the dependency layer survives source-only
# changes. Every workspace's package.json is copied because `npm ci`
# validates the whole lockfile graph even when installing a subset.
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY cli/package.json cli/
COPY mcpjam-inspector/package.json mcpjam-inspector/
COPY design-system/package.json design-system/
COPY chat-ui/package.json chat-ui/
COPY widget-react/package.json widget-react/
COPY soundcheck/package.json soundcheck/
COPY mcp/package.json mcp/
COPY surface-core/package.json surface-core/
COPY slack-app/package.json slack-app/
COPY evaluators/package.json ./evaluators/package.json
COPY discord-app/package.json ./discord-app/package.json
COPY vitest/package.json ./vitest/package.json

# Install ONLY this workspace's runtime subset (~38 MB) instead of the whole
# monorepo — the bot needs @slack/bolt and dotenv, not the inspector's build
# toolchain. --legacy-peer-deps matches CI.
RUN npm ci --legacy-peer-deps \
  --workspace @mcpjam/slack-app \
  --include-workspace-root \
  --omit=dev

COPY slack-app slack-app
COPY surface-core surface-core

# Fail fast and loudly if the process dies; Railway restarts it.
CMD ["npm", "start", "--workspace", "@mcpjam/slack-app"]
