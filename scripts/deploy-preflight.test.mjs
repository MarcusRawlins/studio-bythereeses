import assert from "node:assert/strict";
import { evaluateDeployPreflight } from "./deploy-preflight.mjs";

const clean = evaluateDeployPreflight({
  env: { CLOUDFLARE_API_TOKEN: "token" },
  files: new Set(["src/middleware.ts", "wrangler.jsonc", "pages-proxy/_worker.js"]),
  productionSignals: {
    studioLoginHtml: "<title>The Reeses Studio</title><div>The Reeses Studio</div>",
    scheduleHtml: "<title>Wedding Photography Discovery Call</title><div>The Reeses Studio</div>",
  },
  backupSignals: {
    latestD1: { exists: true, bytes: 1024, ageHours: 1 },
  },
  sourceSignals: {
    mcpSource: [
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
    ].join("\n"),
  },
});

assert.deepEqual(clean.errors, []);
assert.deepEqual(clean.warnings, []);

const blocked = evaluateDeployPreflight({
  env: {},
  files: new Set(["src/proxy.ts", "wrangler.jsonc", "pages-proxy/_worker.js"]),
  productionSignals: {
    studioLoginHtml: "<img alt=\"Alex & Tyler\"><title>The Reeses Studio</title>",
    scheduleHtml: "<div>Alex</div><div>Tyler</div>",
  },
  backupSignals: {
    latestD1: { exists: false },
  },
  sourceSignals: {
    mcpSource: "",
  },
});

assert.deepEqual(blocked.errors, [
  "CLOUDFLARE_API_TOKEN is required for non-interactive Wrangler deploys.",
  "src/middleware.ts is required so the origin guard deploys as Edge middleware on OpenNext Cloudflare.",
  "src/proxy.ts is present; Next.js 16 proxy runs on Node.js, which OpenNext Cloudflare cannot deploy.",
  "A non-empty latest Cloudflare D1 backup is required before deploy.",
  "MCP source is missing required deploy-smoke tool names: studio_get_finance_report, studio_create_agent_task, studio_claim_agent_task, studio_start_agent_task_run, studio_list_agent_tasks, studio_update_agent_task, studio_submit_workflow_task_result, studio_run_workflow_draft_task, studio_list_project_workflow_automations, studio_setup_project_workflow_automation, studio_queue_project_workflow_steps.",
]);
assert.deepEqual(blocked.warnings, [
  "studio.bythereeses.com still appears to contain stale Alex/Tyler branding.",
  "schedule.bythereeses.com still appears to contain stale Alex/Tyler branding.",
]);

console.log("deploy preflight tests passed");
