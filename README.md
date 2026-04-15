# Studio By The Reeses

Operational dashboard for tracking TikTok, Instagram Reels, Stories, and feed posts at `studio.bythereeses.com`.

## What is in this repo

- seeded April 2026 content schedule imported from the editorial calendar
- filterable React dashboard for post inventory and daily schedule review
- Obsidian-aware storage model so the website and vault share one content schema
- Cloudflare Pages deployment scripts via Wrangler

## Local development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Deploy to Cloudflare Pages

Direct upload with Wrangler:

```bash
npm run deploy:pages
```

Preview upload:

```bash
npm run deploy:preview
```

This repo is also ready to be connected to Cloudflare Pages through Git integration.

Recommended Pages settings if you connect the GitHub repo:

- Framework preset: `Vite`
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: `/`

## Obsidian structure

The app is designed to mirror these notes:

- `11 Knowledge Base/Indexes/Short Form Content Index.md`
- `11 Knowledge Base/Indexes/Short Form Post Template.md`
- `11 Knowledge Base/Posts/Short Form Content Workflow.md`
- `03 Content Systems/Short-Form Content Tracker.md`

Use the vault for rules, source context, and durable content memory.
Use the site for operational filtering, schedule review, and quick visibility across channels.
