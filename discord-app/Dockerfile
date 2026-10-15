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
# build.
COPY slack-app/package.json slack-app/
COPY surface-core/package.json surface-core/
COPY discord-app/package.json discord-app/
COPY evaluators/package.json ./evaluators/package.json
COPY vitest/package.json ./vitest/package.json

RUN npm ci --legacy-peer-deps --workspace @mcpjam/discord-app --include-workspace-root --omit=dev
COPY surface-core surface-core
COPY discord-app discord-app
CMD ["npm", "start", "--workspace", "@mcpjam/discord-app"]
