# Cloudflare Workers Setup - Step by Step

## Prerequisites
- Cloudflare account (free tier works)
- Node.js installed

## Step 1: Install Dependencies
```bash
npm install
```

## Step 2: Login to Cloudflare
```bash
npx wrangler login
```
This opens a browser to authenticate.

## Step 3: Bundle Data Files
Since Workers can't read files at runtime, we need to bundle the CSV and images.

The build script automatically runs when you use `npm run dev` or `npm run deploy`, but you can also run it manually:

```bash
npm run bundle-data
```

This creates `src/bundled-data.ts` with embedded CSV and images.

## Step 4: Test Locally
```bash
npm run dev
```
This runs `wrangler dev` - your local development server.

Visit: `http://localhost:8787`

## Step 5: Deploy
```bash
npm run deploy
```

After deployment, you'll see a URL like:
```
https://rabona.YOUR_SUBDOMAIN.workers.dev
```

## Step 6: Connect to ChatGPT
1. Open ChatGPT
2. Go to **Settings** > **Apps & Connectors** > **Create**
3. Name: "Rabona"
4. MCP endpoint: `https://rabona.YOUR_SUBDOMAIN.workers.dev/mcp`
5. Authentication: **No authentication**
6. Click **Create**

## Step 7: Test in ChatGPT
In ChatGPT, type: "Create a new game"

## Important Notes

### What Changed:
- ✅ Express routes → Cloudflare Worker fetch handlers
- ✅ In-memory game state → Durable Objects (persistent)
- ✅ File system reads → Bundled data (build time)
- ✅ Static files → Assets binding

### Files Created:
- `wrangler.toml` - Cloudflare configuration
- `src/worker.ts` - Main Worker entry point
- `src/GameStore.ts` - Durable Object for game state

### Files Modified:
- `package.json` - Added wrangler and Cloudflare types
- `src/SquadStore.ts` - Updated to accept bundled data

## Troubleshooting

**Error: "Cannot find module"**
- Make sure you ran `npm install`

**Error: "CSV not found"**
- Run the bundle script or manually embed CSV data

**MCP endpoint not working**
- Check the URL matches exactly (including `/mcp` at the end)
- Check Cloudflare dashboard for deployment status

**Local dev not working**
- Make sure port 8787 is available
- Check `wrangler.toml` configuration

