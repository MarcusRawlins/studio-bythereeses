import assert from "node:assert/strict";
import { evaluateProductionSmoke } from "./production-smoke.mjs";

const clean = evaluateProductionSmoke({
  studioProjects: { status: 303, location: "https://studio.bythereeses.com/admin/login?next=%2Fprojects" },
  scheduleProjects: { status: 303, location: "https://schedule.bythereeses.com/book/wedding-photography-discovery-call" },
  studioBook: { status: 303, location: "https://schedule.bythereeses.com/book/wedding-photography-discovery-call" },
  directWorker: { status: 404 },
  agentProjects: {
    status: 200,
    json: { projects: Array.from({ length: 5 }, (_, index) => ({ id: `project-${index}` })) },
  },
  agentWorkflows: {
    status: 200,
    json: { availableSteps: Array.from({ length: 12 }, (_, index) => ({ key: `step-${index}` })), workflowRuns: [] },
  },
  dataHealth: {
    status: 200,
    json: { dataHealth: { summary: { projectCount: 165, clientCount: 164, issueCount: 0 } } },
  },
  financeReport: {
    status: 200,
    json: { financeReport: { reconciliation: { totalCount: 0, paymentRows: [], expenseRows: [] } } },
  },
  agentTasks: {
    status: 200,
    json: { agentTasks: [] },
  },
  mcpTools: {
    status: 200,
    json: {
      result: {
        tools: [
          { name: "studio_get_finance_report" },
          { name: "studio_create_agent_task" },
          { name: "studio_claim_agent_task" },
          { name: "studio_start_agent_task_run" },
          { name: "studio_list_agent_tasks" },
          { name: "studio_update_agent_task" },
          { name: "studio_submit_workflow_task_result" },
          { name: "studio_run_workflow_draft_task" },
          { name: "studio_list_project_workflow_automations" },
          { name: "studio_setup_project_workflow_automation" },
          { name: "studio_queue_project_workflow_steps" },
        ],
      },
    },
  },
});

assert.deepEqual(clean.errors, []);
assert.deepEqual(clean.summary, {
  projectCount: 165,
  clientCount: 164,
  dataHealthIssueCount: 0,
  agentProjectRows: 5,
  agentTaskRows: 0,
  workflowAvailableStepCount: 12,
  financeReconciliationCount: 0,
  mcpTaskToolsPresent: true,
  mcpWorkflowToolsPresent: true,
  mcpToolCount: 11,
});

const broken = evaluateProductionSmoke({
  studioProjects: { status: 200 },
  scheduleProjects: { status: 200 },
  studioBook: { status: 200 },
  directWorker: { status: 500 },
  agentProjects: { status: 401, json: {} },
  agentWorkflows: { status: 404, json: {} },
  dataHealth: { status: 200, json: { dataHealth: { summary: { projectCount: 13, clientCount: 14, issueCount: 2 } } } },
  financeReport: { status: 503, json: {} },
  agentTasks: { status: 401, json: {} },
  mcpTools: { status: 200, json: { result: { tools: [{ name: "studio_get_project_context" }] } } },
});

assert.deepEqual(broken.errors, [
  "Studio /projects should redirect unauthenticated browsers to /admin/login.",
  "Schedule /projects should redirect to the public booking surface.",
  "Studio /book/* should redirect to schedule.bythereeses.com.",
  "Direct workers.dev admin/API access should be blocked with 404.",
  "Agent project search should return 200 with bearer auth.",
  "Agent workflow list should return 200 with bearer auth.",
  "Production project count is suspiciously low: 13.",
  "Production client count is suspiciously low: 14.",
  "Data health should have 0 issues, found 2.",
  "Agent finance report should return 200 with bearer auth.",
  "Agent task list should return 200 with bearer auth.",
  "MCP tools/list should expose studio_get_finance_report.",
  "MCP tools/list should expose the durable agent task loop tools.",
  "MCP tools/list should expose the project workflow automation tools.",
]);

console.log("production smoke tests passed");
