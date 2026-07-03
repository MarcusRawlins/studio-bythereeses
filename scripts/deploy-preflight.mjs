import fs from "node:fs";
import path from "node:path";

const STUDIO_URL = "https://studio.bythereeses.com/projects";
const SCHEDULE_URL = "https://schedule.bythereeses.com/book/wedding-photography-discovery-call";
const BACKUP_ROOT = "/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm";
const MAX_D1_BACKUP_AGE_HOURS = 36;
const REQUIRED_MCP_TOOLS = [
  "studio_get_finance_report",
  "studio_create_agent_task",
  "studio_claim_agent_task",
  "studio_start_agent_task_run",
  "studio_list_agent_tasks",
  "studio_update_agent_task",
  "studio_submit_workflow_task_result",
  "studio_run_workflow_draft_task",
  "studio_list_project_workflow_automations",
  "studio_setup_project_workflow_automation",
  "studio_queue_project_workflow_steps",
];

function hasStaleBranding(html) {
  return /Alex\s*&\s*Tyler|Alex<\/|Tyler<\/|alt="Alex & Tyler"/i.test(html);
}

function missingRequiredMcpTools(source = "") {
  return REQUIRED_MCP_TOOLS.filter((toolName) => !source.includes(toolName));
}

function fileInfo(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, path: filePath };
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    path: filePath,
    bytes: stat.size,
    ageHours: Math.round(((Date.now() - stat.mtimeMs) / 36e5) * 10) / 10,
  };
}

export function evaluateDeployPreflight({ env, files, productionSignals = {}, backupSignals = {}, sourceSignals = {} }) {
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

  const latestD1 = backupSignals.latestD1;
  if (latestD1) {
    if (!latestD1.exists || latestD1.bytes <= 0) {
      errors.push("A non-empty latest Cloudflare D1 backup is required before deploy.");
    } else if (latestD1.ageHours > MAX_D1_BACKUP_AGE_HOURS) {
      errors.push(`Latest Cloudflare D1 backup is stale: ${latestD1.ageHours}h old.`);
    }
  }

  const mcpSource = sourceSignals.mcpSource;
  if (typeof mcpSource === "string") {
    const missing = missingRequiredMcpTools(mcpSource);
    if (missing.length > 0) {
      errors.push(`MCP source is missing required deploy-smoke tool names: ${missing.join(", ")}.`);
    }
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
    backupSignals: {
      latestD1: fileInfo(path.join(BACKUP_ROOT, "d1", "latest.sql")),
    },
    sourceSignals: {
      mcpSource: fs.existsSync("src/lib/studio-mcp.ts") ? fs.readFileSync("src/lib/studio-mcp.ts", "utf8") : "",
    },
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
