import fs from "node:fs";

const STUDIO_URL = "https://studio.bythereeses.com/projects";
const SCHEDULE_URL = "https://schedule.bythereeses.com/book/wedding-photography-discovery-call";

function hasStaleBranding(html) {
  return /Alex\s*&\s*Tyler|Alex<\/|Tyler<\/|alt="Alex & Tyler"/i.test(html);
}

export function evaluateDeployPreflight({ env, files, productionSignals = {} }) {
  const errors = [];
  const warnings = [];

  if (!env.CLOUDFLARE_API_TOKEN?.trim()) {
    errors.push("CLOUDFLARE_API_TOKEN is required for non-interactive Wrangler deploys.");
  }
  if (!files.has("src/middleware.ts")) {
    errors.push("src/middleware.ts is required so the origin guard deploys as Edge middleware on OpenNext Cloudflare.");
  }
  if (files.has("src/proxy.ts")) {
    errors.push("src/proxy.ts is present; Next.js 16 proxy runs on Node.js, which OpenNext Cloudflare cannot deploy.");
  }
  if (!files.has("wrangler.jsonc")) {
    errors.push("wrangler.jsonc is required for Cloudflare Worker deployment.");
  }
  if (!files.has("pages-proxy/_worker.js")) {
    errors.push("pages-proxy/_worker.js is required for the studio.bythereeses.com Pages front door.");
  }

  if (productionSignals.studioLoginHtml && hasStaleBranding(productionSignals.studioLoginHtml)) {
    warnings.push("studio.bythereeses.com still appears to contain stale Alex/Tyler branding.");
  }
  if (productionSignals.scheduleHtml && hasStaleBranding(productionSignals.scheduleHtml)) {
    warnings.push("schedule.bythereeses.com still appears to contain stale Alex/Tyler branding.");
  }

  return { errors, warnings };
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  return response.text();
}

async function main() {
  const files = new Set([
    "src/middleware.ts",
    "src/proxy.ts",
    "wrangler.jsonc",
    "pages-proxy/_worker.js",
  ].filter((file) => fs.existsSync(file)));

  const productionSignals = {};
  try {
    productionSignals.studioLoginHtml = await fetchText(STUDIO_URL);
  } catch (error) {
    productionSignals.studioLoginHtml = "";
    console.warn(`Could not fetch ${STUDIO_URL}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    productionSignals.scheduleHtml = await fetchText(SCHEDULE_URL);
  } catch (error) {
    productionSignals.scheduleHtml = "";
    console.warn(`Could not fetch ${SCHEDULE_URL}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = evaluateDeployPreflight({
    env: process.env,
    files,
    productionSignals,
  });

  for (const warning of result.warnings) console.warn(`WARN ${warning}`);
  for (const error of result.errors) console.error(`ERROR ${error}`);

  if (result.errors.length > 0) process.exit(1);
  console.log("Deploy preflight passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
