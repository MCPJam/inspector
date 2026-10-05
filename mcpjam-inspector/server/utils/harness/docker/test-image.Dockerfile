# The hosted-harness CI test image: the computer template's harness bake, on a
# box a GitHub runner can start.
#
# It mirrors what mcpjam-backend `templates/computer/e2b.Dockerfile` does for
# the harness — the same base digest, the same exact Node and pnpm, the same
# bake context installed by the same `bake.mjs` as the same runtime user — and
# nothing else from that image (no shell branding, no clipboard shim). The
# Docker CI job runs `runHarnessTurn` against containers of this image, so a
# turn there starts on a BAKED box exactly like a fresh computer would.
#
# Build (from mcpjam-inspector/):
#
#   node scripts/harness-bake-context.mjs --out "$CTX/harness-bake"
#   docker build -f server/utils/harness/docker/test-image.Dockerfile \
#     -t mcpjam-harness-test "$CTX"
#
# The build context is the bake context's PARENT: it must hold `harness-bake/`.
#
# `harness-bake.test.ts` asserts the Node and pnpm pins below equal
# `harness-bake.ts` (and so `scripts/local-harness-toolchain.json`), and that
# the base stays pinned by digest. `BASE_IMAGE` is overridable only so a
# developer behind a TLS-intercepting proxy can layer a CA onto the SAME digest.
ARG BASE_IMAGE=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

# procps for the lifecycle checks (`ps`, `pgrep`); git because the vendor CLIs
# probe for a repository; xz for the Node tarball.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils git procps \
    && rm -rf /var/lib/apt/lists/*

# Node by exact version AND checksum, from nodejs.org — not a distro or
# NodeSource channel that moves underneath the pin.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) node_arch=x64; node_sha=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2 ;; \
      arm64) node_arch=arm64; node_sha=5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7 ;; \
      *) echo "unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-${node_arch}.tar.xz"; \
    echo "${node_sha}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    test "$(node --version)" = "v24.20.0"

# pnpm by exact version, into /usr/local/bin so every shell finds it.
RUN npm install -g pnpm@10.18.1 && test "$(pnpm --version)" = "10.18.1"

# The runtime user. E2B provisions `user` itself; a plain Docker build has to.
RUN id -u user >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --uid 1000 user

# The bake: the context's CONTENTS land where the framework looks for markers,
# owned by the runtime user, and `bake.mjs` installs and verifies every recipe
# AS that user before it writes a single marker.
COPY harness-bake/ /home/user/.harness-bootstrap/
RUN chown -R user:user /home/user/.harness-bootstrap
USER user
WORKDIR /home/user
RUN node /home/user/.harness-bootstrap/bake.mjs

CMD ["sleep", "infinity"]
