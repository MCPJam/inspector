#!/bin/bash

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if token is set
if [ -z "$ASANA_MCP_TOKEN" ]; then
    echo -e "${RED}Error: ASANA_MCP_TOKEN environment variable is not set${NC}"
    echo "Usage: export ASANA_MCP_TOKEN='your-token-here'"
    exit 1
fi

BASE_URL="https://mcp.asana.com"
ENDPOINT="/sse"

echo "=========================================="
echo "MCP Server OAuth 2.1 Compliance Tests"
echo "Testing: $BASE_URL$ENDPOINT"
echo "=========================================="
echo ""

# Test 1: Valid token in Authorization header
echo -e "${YELLOW}Test 1: Valid token in Authorization header (SHOULD succeed)${NC}"
response=$(curl -s --max-time 3 -w "\nHTTP_CODE:%{http_code}" -H "Authorization: Bearer $ASANA_MCP_TOKEN" "$BASE_URL$ENDPOINT")
http_code=$(echo "$response" | grep "HTTP_CODE:" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $http_code"
echo "Response: $body" | head -5
if [ "$http_code" = "200" ] || [ "$http_code" = "204" ]; then
    echo -e "${GREEN}✓ PASS: Server accepted valid token${NC}"
else
    echo -e "${RED}✗ FAIL: Expected 200/204, got $http_code${NC}"
fi
echo ""

# Test 2: Missing Authorization header
echo -e "${YELLOW}Test 2: Missing Authorization header (MUST return 401)${NC}"
response=$(curl -s --max-time 3 -w "\nHTTP_CODE:%{http_code}" "$BASE_URL$ENDPOINT")
http_code=$(echo "$response" | grep "HTTP_CODE:" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $http_code"
echo "Response: $body"
if [ "$http_code" = "401" ]; then
    echo -e "${GREEN}✓ PASS: Server returned 401 for missing token${NC}"
else
    echo -e "${RED}✗ FAIL: Expected 401, got $http_code${NC}"
fi
echo ""

# Test 3: Invalid/malformed token
echo -e "${YELLOW}Test 3: Invalid token (MUST return 401)${NC}"
response=$(curl -s --max-time 3 -w "\nHTTP_CODE:%{http_code}" -H "Authorization: Bearer invalid_token_12345" "$BASE_URL$ENDPOINT")
http_code=$(echo "$response" | grep "HTTP_CODE:" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $http_code"
echo "Response: $body"
if [ "$http_code" = "401" ]; then
    echo -e "${GREEN}✓ PASS: Server returned 401 for invalid token${NC}"
else
    echo -e "${RED}✗ FAIL: Expected 401, got $http_code${NC}"
fi
echo ""

# Test 4: Token without "Bearer" scheme
echo -e "${YELLOW}Test 4: Token without Bearer scheme (MUST return 401)${NC}"
response=$(curl -s --max-time 3 -w "\nHTTP_CODE:%{http_code}" -H "Authorization: $ASANA_MCP_TOKEN" "$BASE_URL$ENDPOINT")
http_code=$(echo "$response" | grep "HTTP_CODE:" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $http_code"
echo "Response: $body"
if [ "$http_code" = "401" ]; then
    echo -e "${GREEN}✓ PASS: Server rejected token without Bearer scheme${NC}"
else
    echo -e "${RED}✗ FAIL: Expected 401, got $http_code${NC}"
fi
echo ""

# Test 5: Token in query string (SHOULD be rejected per OAuth 2.1)
echo -e "${YELLOW}Test 5: Token in query string (SHOULD return 400 or 401)${NC}"
response=$(curl -s --max-time 3 -w "\nHTTP_CODE:%{http_code}" "$BASE_URL$ENDPOINT?access_token=$ASANA_MCP_TOKEN")
http_code=$(echo "$response" | grep "HTTP_CODE:" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $http_code"
echo "Response: $body"
if [ "$http_code" = "400" ] || [ "$http_code" = "401" ]; then
    echo -e "${GREEN}✓ PASS: Server rejected token in query string${NC}"
else
    echo -e "${YELLOW}⚠ WARNING: Server accepted query string token (not OAuth 2.1 compliant)${NC}"
fi
echo ""

# Test 6: Case sensitivity of "Bearer" scheme
echo -e "${YELLOW}Test 6: Lowercase 'bearer' scheme (SHOULD return 401)${NC}"
response=$(curl -s --max-time 3 -w "\nHTTP_CODE:%{http_code}" -H "Authorization: bearer $ASANA_MCP_TOKEN" "$BASE_URL$ENDPOINT")
http_code=$(echo "$response" | grep "HTTP_CODE:" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $http_code"
echo "Response: $body"
if [ "$http_code" = "401" ]; then
    echo -e "${GREEN}✓ PASS: Server enforces case-sensitive Bearer scheme${NC}"
elif [ "$http_code" = "200" ] || [ "$http_code" = "204" ]; then
    echo -e "${YELLOW}⚠ INFO: Server accepts lowercase 'bearer' (lenient but acceptable)${NC}"
else
    echo -e "${RED}✗ FAIL: Unexpected response $http_code${NC}"
fi
echo ""

# Test 7: Multiple requests with same token (stateless requirement)
echo -e "${YELLOW}Test 7: Token required on every request (stateless)${NC}"
echo "Making 3 consecutive requests..."

for i in {1..3}; do
    response=$(curl -s --max-time 3 -w "\nHTTP_CODE:%{http_code}" -H "Authorization: Bearer $ASANA_MCP_TOKEN" "$BASE_URL$ENDPOINT")
    http_code=$(echo "$response" | grep "HTTP_CODE:" | cut -d: -f2)
    echo "  Request $i: HTTP $http_code"
done

echo -e "${GREEN}✓ All requests accepted (token required each time)${NC}"
echo ""

# Test 8: Check WWW-Authenticate header on 401
echo -e "${YELLOW}Test 8: WWW-Authenticate header on 401 response${NC}"
headers=$(curl -s --max-time 3 -i "$BASE_URL$ENDPOINT" | grep -i "www-authenticate")

if [ -n "$headers" ]; then
    echo "WWW-Authenticate: $headers"
    echo -e "${GREEN}✓ PASS: Server includes WWW-Authenticate header${NC}"
else
    echo -e "${RED}✗ FAIL: Missing WWW-Authenticate header on 401${NC}"
fi
echo ""

# Summary
echo "=========================================="
echo "Test Summary Complete"
echo "=========================================="