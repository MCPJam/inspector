# THROWAWAY spike template for the Hosted Browser + WebMCP Runtime M0 spike.
# Built end-to-end and validated 2026-08-28 (see ../../SPIKE_FINDINGS.md). The
# production W1 template (mcpjam-backend/templates/desktop/) descends from this.
#
# Base is the E2B desktop image (Xfce + Xvfb + x11vnc + noVNC:6080 already
# baked), which is what `@e2b/desktop` boots as template "desktop". We layer only
# what the runtime needs; E2B templates support FROM/RUN/ENV/COPY only.
FROM e2bdev/desktop:latest

ENV DEBIAN_FRONTEND=noninteractive

# Node 20 — the browserd daemon is a Node process, and the stock desktop image
# ships neither node nor npm (spike finding A: sandboxHasNode=false).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Playwright-core pinned to the WebMCP-validated version, plus its Chromium
# 151.0.7922.34. The stock image's Chrome is 150.x — below the WebMCP pin.
#
# CRITICAL (spike finding): the build runs as root but the sandbox runs as
# `user`. Playwright's default browser cache ($HOME/.cache/ms-playwright =
# /root/.cache at build time) is unreadable by `user`, so the launch silently
# finds no browser. Force the browsers into a world-readable path and export it
# at runtime. Resulting binary:
#   /opt/mcpjam/ms-playwright/chromium-1234/chrome-linux64/chrome
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/mcpjam/ms-playwright
RUN mkdir -p /opt/mcpjam/browserd /opt/mcpjam/ms-playwright \
    && cd /opt/mcpjam/browserd \
    && npm init -y >/dev/null 2>&1 \
    && npm install playwright-core@1.62.1 \
    && npx playwright@1.62.1 install chromium --with-deps \
    && chmod -R a+rX /opt/mcpjam
