import { spawnSync } from "node:child_process";

const studioBaseUrl = process.env.SMOKE_STUDIO_URL || "https://studio.bythereeses.com";
const scheduleBaseUrl = process.env.SMOKE_SCHEDULE_URL || "https://schedule.bythereeses.com";
const workerOrigin = process.env.SMOKE_WORKER_ORIGIN || "https://reese-photography-crm.solitary-flower-c3ab.workers.dev";
const bookingSlug = process.env.SMOKE_BOOKING_SLUG || "wedding-photography-discovery-call";

function cleanBaseUrl(value) {
  return value.replace(/\/$/, "");
}

function keychainAgentToken() {
  if (process.platform !== "darwin") return "";
  const result = spawnSync("security", [
    "find-generic-password",
    "-a",
    "studio.bythereeses.com",
    "-s",
    "reese-studio-agent-api-token",
    "-w",
  ], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function hasFinanceTool(tools = []) {
  return tools.some((tool) => tool?.name === "studio_get_finance_report");
}

function hasAgentTaskLoopTools(tools = []) {
  const names = new Set(tools.map((tool) => tool?.name));
  return [
    "studio_create_agent_task",
    "studio_claim_agent_task",
    "studio_start_agent_task_run",
    "studio_list_agent_tasks",
    "studio_update_agent_task",
    "studio_submit_workflow_task_result",
    "studio_run_workflow_draft_task",
  ].every((name) => names.has(name));
}

function hasProjectWorkflowTools(tools = []) {
  const names = new Set(tools.map((tool) => tool?.name));
  return [
    "studio_list_project_workflow_automations",
    "studio_setup_project_workflow_automation",
    "studio_queue_project_workflow_steps",
  ].every((name) => names.has(name));
}

function locationIncludes(result, text) {
  return typeof result?.location === "string" && result.location.includes(text);
}

export function evaluateProductionSmoke(results) {
  const errors = [];
  const projectCount = Number(results.dataHealth?.json?.dataHealth?.summary?.projectCount ?? 0);
  const clientCount = Number(results.dataHealth?.json?.dataHealth?.summary?.clientCount ?? 0);
  const dataHealthIssueCount = Number(results.dataHealth?.json?.dataHealth?.summary?.issueCount ?? 0);
  const agentProjectRows = Array.isArray(results.agentProjects?.json?.projects)
    ? results.agentProjects.json.projects.length
    : 0;
  const agentTaskRows = Array.isArray(results.agentTasks?.json?.agentTasks)
    ? results.agentTasks.json.agentTasks.length
    : 0;
  const workflowAvailableStepCount = Array.isArray(results.agentWorkflows?.json?.availableSteps)
    ? results.agentWorkflows.json.availableSteps.length
    : 0;
  const financeReconciliationCount = Number(results.financeReport?.json?.financeReport?.reconciliation?.totalCount ?? 0);
  const mcpTools = results.mcpTools?.json?.result?.tools ?? [];
  const mcpToolCount = Array.isArray(mcpTools) ? mcpTools.length : 0;
  const mcpTaskToolsPresent = hasAgentTaskLoopTools(Array.isArray(mcpTools) ? mcpTools : []);
  const mcpWorkflowToolsPresent = hasProjectWorkflowTools(Array.isArray(mcpTools) ? mcpTools : []);

  if (results.studioProjects?.status !== 303 || !locationIncludes(results.studioProjects, "/admin/login")) {
    errors.push("Studio /projects should redirect unauthenticated browsers to /admin/login.");
  }
  if (results.scheduleProjects?.status !== 303 || !locationIncludes(results.scheduleProjects, `/book/${bookingSlug}`)) {
    errors.push("Schedule /projects should redirect to the public booking surface.");
  }
  if (results.studioBook?.status !== 303 || !locationIncludes(results.studioBook, "schedule.bythereeses.com")) {
    errors.push("Studio /book/* should redirect to schedule.bythereeses.com.");
  }
  if (results.directWorker?.status !== 404) {
    errors.push("Direct workers.dev admin/API access should be blocked with 404.");
  }
  // Phase 9b PRECONDITION AUTH-ARMED (M2 / §9.20): an unauthenticated POST to the refund
  // EXECUTE route on the *.workers.dev origin (no origin secret, no admin proof) must 404.
  // This is the pre-enable assertion that ORIGIN_PROXY_SECRET is set at the Worker and
  // ADMIN_PROOF_ENFORCE=1 — both fail OPEN when unset, so a hole here would leave the most
  // destructive action in the app unauthenticated-reachable. Only runs when supplied.
  if (results.refundExecuteDirect && results.refundExecuteDirect.status !== 404) {
    errors.push("Direct workers.dev POST to refund/execute must be blocked with 404 (auth boundary not armed).");
  }
  if (results.agentProjects?.status !== 200) {
    errors.push("Agent project search should return 200 with bearer auth.");
  }
  if (results.agentWorkflows?.status !== 200) {
    errors.push("Agent workflow list should return 200 with bearer auth.");
  }
  if (projectCount < 100) {
    errors.push(`Production project count is suspiciously low: ${projectCount}.`);
  }
  if (clientCount < 100) {
    errors.push(`Production client count is suspiciously low: ${clientCount}.`);
  }
  if (dataHealthIssueCount !== 0) {
    errors.push(`Data health should have 0 issues, found ${dataHealthIssueCount}.`);
  }
  if (results.financeReport?.status !== 200) {
    errors.push("Agent finance report should return 200 with bearer auth.");
  }
  if (results.agentTasks?.status !== 200) {
    errors.push("Agent task list should return 200 with bearer auth.");
  }
  // Phase 21 config-verification companion: /api/agent/health must be LIVE + shaped. The
  // /api/agent/ prefix is what makes it reachable through the proxy at all (a bare /api/health
  // would 303/404). Do NOT fail on warn/critical — that's a real runtime signal, not a smoke
  // failure; assert only that the endpoint is up and `overall` is one of the known values.
  if (results.agentHealth) {
    const overall = results.agentHealth.json?.overall;
    if (results.agentHealth.status !== 200) {
      errors.push("Agent systems-health endpoint (/api/agent/health) should return 200 with bearer auth.");
    } else if (!["green", "warn", "critical"].includes(overall)) {
      errors.push(`Agent systems-health 'overall' should be green|warn|critical, got ${overall}.`);
    }
  }
  if (!hasFinanceTool(Array.isArray(mcpTools) ? mcpTools : [])) {
    errors.push("MCP tools/list should expose studio_get_finance_report.");
  }
  if (!mcpTaskToolsPresent) {
    errors.push("MCP tools/list should expose the durable agent task loop tools.");
  }
  if (!mcpWorkflowToolsPresent) {
    errors.push("MCP tools/list should expose the project workflow automation tools.");
  }
  // Optional checks: only run when the caller supplies these results (production
  // runProductionSmoke() does; existing unit-test fixtures omit them and are unaffected).
  if (results.proposalReferrerPolicy && results.proposalReferrerPolicy.referrerPolicy !== "no-referrer") {
    errors.push("Proposal surfaces (/proposal/**) should send referrer-policy: no-referrer.");
  }
  if (results.defaultReferrerPolicy && results.defaultReferrerPolicy.referrerPolicy !== "strict-origin-when-cross-origin") {
    errors.push("Non-proposal surfaces should keep the default strict-origin-when-cross-origin referrer-policy.");
  }

  return {
    errors,
    summary: {
      projectCount,
      clientCount,
      dataHealthIssueCount,
      agentProjectRows,
      agentTaskRows,
      workflowAvailableStepCount,
      financeReconciliationCount,
      mcpTaskToolsPresent,
      mcpWorkflowToolsPresent,
      mcpToolCount,
    },
  };
}

async function fetchHead(url) {
  const response = await fetch(url, { method: "HEAD", redirect: "manual" });
  return {
    status: response.status,
    location: response.headers.get("location"),
  };
}

// Phase 9b: assert an unauthenticated method-specific request (e.g. POST refund/execute)
// is origin-guarded to 404 on the direct Worker origin. Sends an empty JSON body.
async function fetchStatus(url, method) {
  const response = await fetch(url, {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: method === "GET" || method === "HEAD" ? undefined : "{}",
  });
  return { status: response.status };
}

// L7 (phase-6-hardening-r2.md, Section 3): the proxy must force `no-referrer` on
// proposal surfaces (token lives in the URL) and keep the default
// strict-origin-when-cross-origin policy everywhere else.
async function fetchReferrerPolicy(url) {
  const response = await fetch(url, { method: "HEAD", redirect: "manual" });
  return {
    status: response.status,
    referrerPolicy: response.headers.get("referrer-policy"),
  };
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });
  let json = null;
  const text = await response.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { parseError: text.slice(0, 200) };
    }
  }
  return {
    status: response.status,
    json,
  };
}

async function callMcpToolsList(url, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
  };
}

async function runProductionSmoke() {
  const token = process.env.STUDIO_AGENT_API_TOKEN?.trim() || keychainAgentToken();
  if (!token) {
    throw new Error("STUDIO_AGENT_API_TOKEN is required in env or Keychain service reese-studio-agent-api-token.");
  }

  const studio = cleanBaseUrl(studioBaseUrl);
  const schedule = cleanBaseUrl(scheduleBaseUrl);
  const worker = cleanBaseUrl(workerOrigin);
  const results = {
    studioProjects: await fetchHead(`${studio}/projects`),
    scheduleProjects: await fetchHead(`${schedule}/projects`),
    studioBook: await fetchHead(`${studio}/book/${bookingSlug}`),
    directWorker: await fetchHead(`${worker}/projects`),
    refundExecuteDirect: await fetchStatus(`${worker}/api/invoices/smoke-inv/payments/smoke-pay/refund/execute`, "POST"),
    agentProjects: await fetchJson(`${studio}/api/agent/projects?limit=5&page=1&sort=eventDate`, token),
    dataHealth: await fetchJson(`${studio}/api/agent/data-health`, token),
    financeReport: await fetchJson(`${studio}/api/agent/finance/report?paymentStatus=needs_reconciliation&expenseStatus=needs_reconciliation`, token),
    agentTasks: await fetchJson(`${studio}/api/agent/tasks?limit=5`, token),
    agentHealth: await fetchJson(`${studio}/api/agent/health`, token),
    mcpTools: await callMcpToolsList(`${studio}/api/mcp`, token),
    proposalReferrerPolicy: await fetchReferrerPolicy(`${studio}/proposal/smoke-check-${Date.now()}`),
    defaultReferrerPolicy: await fetchReferrerPolicy(`${studio}/admin/login`),
  };
  const firstProjectId = results.agentProjects?.json?.projects?.[0]?.id;
  results.agentWorkflows = firstProjectId
    ? await fetchJson(`${studio}/api/agent/projects/${firstProjectId}/workflows`, token)
    : { status: 0, json: null };
  const evaluation = evaluateProductionSmoke(results);
  console.log(JSON.stringify(evaluation.summary, null, 2));
  if (evaluation.errors.length) {
    for (const error of evaluation.errors) console.error(`ERROR ${error}`);
    process.exit(1);
  }
  console.log("production smoke checks passed");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProductionSmoke().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
