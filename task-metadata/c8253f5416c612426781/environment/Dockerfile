FROM mcpjam-harbor-agent:v1
RUN printf "@mcpjam:registry=http://fixture:8765/registry/\n" > /usr/local/etc/npmrc
RUN printf '{"mcpServers":{"arithmetic":{"url":"http://fixture:8765/mcp"}}}\n' > /workspace/mcp.json
