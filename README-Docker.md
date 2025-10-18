# Docker Setup for MCP Inspector

This guide explains how to use Docker with the MCP Inspector project, leveraging the existing [mcpjam/mcp-inspector](https://hub.docker.com/r/mcpjam/mcp-inspector) image on Docker Hub.

## Quick Start

### Using Pre-built Image from Docker Hub

```bash
# Pull and run the latest version
docker run -p 3001:3001 mcpjam/mcp-inspector:latest

# Or using docker-compose
docker-compose -f docker-compose.prod.yml up -d
```

### Building Locally

```bash
# Build the production image
npm run docker:build

# Build the development image
npm run docker:build:dev

# Run locally built image
npm run docker:run
```

## Available Docker Commands

| Command                    | Description                                    |
| -------------------------- | ---------------------------------------------- |
| `npm run docker:build`     | Build production Docker image                  |
| `npm run docker:build:dev` | Build development Docker image                 |
| `npm run docker:run`       | Run production container                       |
| `npm run docker:run:dev`   | Run development container                      |
| `npm run docker:up`        | Start production services with docker-compose  |
| `npm run docker:up:dev`    | Start development services with docker-compose |
| `npm run docker:down`      | Stop all services                              |
| `npm run docker:logs`      | View container logs                            |
| `npm run docker:clean`     | Clean up containers, volumes, and images       |

## Docker Compose Profiles

### Development Profile

```bash
# Start development environment with hot-reloading
docker run -e CONVEX_HTTP_URL=https://your-convex-url.convex.cloud -p 3001:3001 mcpjam/mcp-inspector:latest

# View logs
docker-compose logs -f mcp-inspector-dev
```

### Production Profile

```bash
# Start production environment
docker-compose --profile production up -d

# Or use the dedicated production compose file
docker-compose -f docker-compose.prod.yml up -d
```

## Configuration

### Environment Variables

| Variable   | Default      | Description      |
| ---------- | ------------ | ---------------- |
| `NODE_ENV` | `production` | Environment mode |
| `PORT`     | `3001`       | Server port      |

### Volumes

- `mcp_data`: Persistent data storage
- Development mode mounts source code for hot-reloading

## CI/CD Integration

The project includes GitHub Actions workflows for:

1. **Build and Deploy** (`.github/workflows/docker-build-deploy.yml`)
   - Runs tests
   - Builds Docker images
   - Pushes to Docker Hub
   - Deploys to staging/production

2. **Security Scanning** (`.github/workflows/docker-security-scan.yml`)
   - Daily vulnerability scans
   - Trivy and Snyk integration
   - SARIF reports to GitHub Security tab

### Required Secrets

Add these secrets to your GitHub repository:

| Secret            | Description               |
| ----------------- | ------------------------- |
| `DOCKER_USERNAME` | Docker Hub username       |
| `DOCKERHUB_TOKEN` | Docker Hub password/token |
| `SNYK_TOKEN`      | Snyk API token (optional) |

## Multi-Architecture Support

The Docker images support multiple architectures:

- `linux/amd64` (Intel/AMD processors)
- `linux/arm64` (ARM processors, including Apple Silicon)

## Health Checks

Both development and production containers include health checks:

- Endpoint: `http://localhost:3001/health`
- Interval: 30 seconds
- Timeout: 10 seconds
- Retries: 3

## Security Features

- Non-root user (`mcpjam:nodejs`)
- Minimal Alpine Linux base image
- Security scanning in CI/CD
- Proper signal handling with `dumb-init`

## Troubleshooting

### Common Issues

1. **Port already in use**

   ```bash
   # Check what's using port 3001
   lsof -i :3001

   # Use different port
   docker run -p 3002:3001 mcpjam/mcp-inspector:latest
   ```

2. **Permission issues**

   ```bash
   # Check container logs
   docker logs <container_name>

   # Ensure proper ownership
   docker exec -it <container_name> ls -la /app
   ```

3. **Build failures**

   ```bash
   # Clean Docker cache
   docker system prune -a

   # Rebuild without cache
   docker build --no-cache -t mcpjam/mcp-inspector:latest .
   ```

### Debugging

```bash
# Access container shell
docker exec -it <container_name> sh

# View container logs
docker logs -f <container_name>

# Inspect container
docker inspect <container_name>
```

## Production Deployment

For production deployment, consider:

1. **Use docker-compose.prod.yml**
2. **Set up reverse proxy (Nginx)**
3. **Configure SSL certificates**
4. **Set up monitoring and logging**
5. **Configure backup for persistent volumes**

## Links

- [Docker Hub Repository](https://hub.docker.com/r/mcpjam/mcp-inspector)
- [Project Repository](https://github.com/mcpjam/inspector)
- [MCP Jam Website](https://mcpjam.com)
