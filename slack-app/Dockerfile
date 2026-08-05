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
COPY slack-app/package.json slack-app/
COPY surface-core/package.json surface-core/

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
