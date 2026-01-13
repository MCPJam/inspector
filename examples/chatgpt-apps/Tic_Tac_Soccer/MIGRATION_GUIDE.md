# Cloudflare Workers Migration Guide

## Step-by-Step Instructions

### Step 1: Install Dependencies
```bash
npm install
```

This will install `wrangler` and `@cloudflare/workers-types` that were added to package.json.

### Step 2: Login to Cloudflare
```bash
npx wrangler login
```

This will open a browser to authenticate with your Cloudflare account.

### Step 3: Test Locally
```bash
npm run dev
```

This runs `wrangler dev` which starts a local development server.

### Step 4: Deploy to Cloudflare
```bash
npm run deploy
```

This runs `wrangler deploy` which builds and deploys your app.

### Step 5: Get Your Deployment URL
After deployment, wrangler will show you a URL like:
```
https://rabona.YOUR_SUBDOMAIN.workers.dev
```

### Step 6: Connect to ChatGPT
1. Open ChatGPT
2. Go to **Settings** > **Apps & Connectors** > **Create**
3. Enter your MCP endpoint: `https://rabona.YOUR_SUBDOMAIN.workers.dev/mcp`
4. Select **"No authentication"**
5. Click **"Create"**

## Important Notes

- The worker.ts file converts your Express app to Cloudflare Workers format
- Game state is stored in Durable Objects (persistent across requests)
- Images and CSV are bundled at build time (no runtime file reads)
- Static files in `public/` are served via Assets binding

## Troubleshooting

- If you see errors about missing files, make sure `data/squads_2025_26.csv` exists
- If MCP endpoint doesn't work, check the URL format matches exactly
- For local dev, use `npm run dev` (not the old `tsx watch` command)

