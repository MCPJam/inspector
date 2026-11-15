FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 curl git ca-certificates procps util-linux && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@0.160.0 @anthropic-ai/claude-code@2.1.323
RUN mkdir -p /workspace /capture && chmod 1777 /capture
WORKDIR /workspace
ENV DO_NOT_TRACK=1 MCPJAM_TELEMETRY_DISABLED=1 DISABLE_AUTOUPDATER=1
COPY shell_capture.py /usr/local/lib/shell_capture.py
RUN mv /bin/bash /bin/bash.real && ln -s /usr/local/lib/shell_capture.py /bin/bash && chmod 755 /usr/local/lib/shell_capture.py
