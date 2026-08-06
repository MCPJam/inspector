FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY cli/package.json cli/
COPY mcpjam-inspector/package.json mcpjam-inspector/
COPY design-system/package.json design-system/
COPY chat-ui/package.json chat-ui/
COPY widget-react/package.json widget-react/
COPY soundcheck/package.json soundcheck/
COPY mcp/package.json mcp/
# Every workspace's manifest, not just this app's: `npm ci` validates the whole
# lockfile graph even when installing a subset, so a missing sibling fails the
# build. (`quality-labeler` is listed in workspaces but has no directory; npm
# tolerates that, which is why it is absent here and in slack-app/Dockerfile.)
COPY slack-app/package.json slack-app/
COPY surface-core/package.json surface-core/
COPY discord-app/package.json discord-app/
RUN npm ci --legacy-peer-deps --workspace @mcpjam/discord-app --include-workspace-root --omit=dev
COPY surface-core surface-core
COPY discord-app discord-app
CMD ["npm", "start", "--workspace", "@mcpjam/discord-app"]
