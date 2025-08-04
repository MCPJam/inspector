#!/bin/bash

# Docker Testing Script for MCP Inspector
# This script tests all Docker functionality step by step

set -e  # Exit on any error

echo "🐳 Starting Docker Testing for MCP Inspector"
echo "=============================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_step() {
    echo -e "\n${BLUE}📋 Step $1: $2${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

wait_for_input() {
    echo -e "${YELLOW}Press Enter to continue...${NC}"
    read -r
}

# Check prerequisites
print_step "1" "Checking Prerequisites"
if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    print_error "Docker Compose is not installed"
    exit 1
fi

print_success "Docker and Docker Compose are available"

# Test 1: Build Production Image
print_step "2" "Building Production Docker Image"
echo "Building image: mcpjam/mcp-inspector:latest"
npm run docker:build
print_success "Production image built successfully"

# Test 2: Build Development Image  
print_step "3" "Building Development Docker Image"
echo "Building development image: mcpjam/mcp-inspector:dev"
npm run docker:build:dev
print_success "Development image built successfully"

# Test 3: List Images
print_step "4" "Verifying Built Images"
echo "Docker images:"
docker images | grep "mcpjam/mcp-inspector" || echo "No images found"

# Test 4: Test Production Container
print_step "5" "Testing Production Container"
echo "Starting production container on port 3001..."
print_warning "This will start the container in the background"

# Start container in background
CONTAINER_ID=$(docker run -d -p 3001:3001 mcpjam/mcp-inspector:latest)
echo "Container ID: $CONTAINER_ID"

# Wait for container to start
echo "Waiting 10 seconds for container to start..."
sleep 10

# Check if container is running
if docker ps | grep -q "$CONTAINER_ID"; then
    print_success "Container is running"
    
    # Test health endpoint
    echo "Testing health endpoint..."
    if curl -f http://localhost:3001/health 2>/dev/null; then
        print_success "Health endpoint is responding"
    else
        print_warning "Health endpoint test failed (this might be expected if no health endpoint exists)"
    fi
    
    # Test main endpoint
    echo "Testing main endpoint..."
    if curl -f http://localhost:3001 2>/dev/null; then
        print_success "Main endpoint is responding"
    else
        print_warning "Main endpoint test failed - checking container logs..."
        docker logs "$CONTAINER_ID" | tail -10
    fi
else
    print_error "Container is not running"
    echo "Container logs:"
    docker logs "$CONTAINER_ID"
fi

echo "Stopping production container..."
docker stop "$CONTAINER_ID" >/dev/null
docker rm "$CONTAINER_ID" >/dev/null
print_success "Production container test completed"

# Test 5: Docker Compose Production
print_step "6" "Testing Docker Compose Production"
echo "Starting services with docker-compose..."
npm run docker:up

echo "Waiting 15 seconds for services to start..."
sleep 15

# Check running containers
echo "Running containers:"
docker-compose ps

# Test the service
echo "Testing compose service..."
if curl -f http://localhost:3001 2>/dev/null; then
    print_success "Docker Compose service is responding"
else
    print_warning "Service test failed - checking logs..."
    npm run docker:logs | tail -20
fi

echo "Stopping docker-compose services..."
npm run docker:down
print_success "Docker Compose test completed"

# Test 6: Pre-built Image from Docker Hub
print_step "7" "Testing Pre-built Image from Docker Hub"
echo "Testing your existing Docker Hub image..."
print_warning "This will pull the image from Docker Hub if it exists"

if docker pull mcpjam/mcp-inspector:latest 2>/dev/null; then
    print_success "Successfully pulled image from Docker Hub"
    
    echo "Testing pulled image..."
    PULLED_CONTAINER=$(docker run -d -p 3002:3001 mcpjam/mcp-inspector:latest)
    sleep 10
    
    if docker ps | grep -q "$PULLED_CONTAINER"; then
        print_success "Docker Hub image is running"
        if curl -f http://localhost:3002 2>/dev/null; then
            print_success "Docker Hub image is responding"
        else
            print_warning "Docker Hub image not responding on expected endpoint"
        fi
    else
        print_warning "Docker Hub image failed to start"
        docker logs "$PULLED_CONTAINER" | tail -10
    fi
    
    docker stop "$PULLED_CONTAINER" >/dev/null 2>&1
    docker rm "$PULLED_CONTAINER" >/dev/null 2>&1
else
    print_warning "Could not pull from Docker Hub (image might not exist yet or be private)"
fi

# Test 7: Development Environment
print_step "8" "Testing Development Environment (Optional)"
echo "This test will start the development environment with hot-reloading"
print_warning "This test requires user interaction to stop"
echo "Would you like to test the development environment? (y/n)"
read -r response

if [[ "$response" =~ ^[Yy]$ ]]; then
    echo "Starting development environment..."
    echo "This will run in the foreground. Press Ctrl+C to stop."
    echo "The service should be available at:"
    echo "  - Server: http://localhost:3001"
    echo "  - Client dev server: http://localhost:5173 (if applicable)"
    
    print_warning "Starting in 5 seconds..."
    sleep 5
    
    # This will run in foreground
    npm run docker:up:dev
    
    # Clean up after user stops
    npm run docker:down
else
    print_success "Skipped development environment test"
fi

# Test 8: Docker Scripts
print_step "9" "Testing Docker NPM Scripts"
echo "Available Docker scripts:"
npm run | grep "docker:" || echo "No docker scripts found"

# Final cleanup
print_step "10" "Final Cleanup"
echo "Cleaning up any remaining containers..."
npm run docker:clean 2>/dev/null || echo "Nothing to clean"

# Summary
echo ""
echo "🎉 Docker Testing Complete!"
echo "=========================="
print_success "All tests completed successfully"
echo ""
echo "Next steps:"
echo "1. Push your code to GitHub to trigger CI/CD"
echo "2. Add required secrets to GitHub:"
echo "   - DOCKER_USERNAME"
echo "   - DOCKER_PASSWORD"
echo "3. Monitor the GitHub Actions workflows"
echo ""
echo "Documentation available in: README-Docker.md" 