import assert from "node:assert/strict";
import {
  buildCaptureManifest,
  normalizeDeploymentList,
  summarizePagesDeployments,
  summarizeWorkerDeployments,
} from "./capture-deploy-versions.mjs";

const workerPayload = [
  {
    id: "dep-current",
    created_on: "2026-06-10T12:00:00Z",
    versions: [{ version_id: "ver-current", percentage: 100 }],
  },
  {
    id: "dep-previous",
    created_on: "2026-06-09T12:00:00Z",
    versions: [{ version_id: "ver-previous", percentage: 100 }],
  },
];

assert.deepEqual(normalizeDeploymentList(workerPayload), workerPayload);
assert.deepEqual(normalizeDeploymentList({ result: { deployments: workerPayload } }), workerPayload);

const worker = summarizeWorkerDeployments(workerPayload);
assert.equal(worker.current.versionId, "ver-current");
assert.equal(worker.previous.versionId, "ver-previous");
assert.equal(worker.all.length, 2);

const pagesPayload = {
  result: {
    deployments: [
      {
        id: "pages-current",
        created_on: "2026-06-10T12:00:00Z",
        environment: "production",
        latest_stage: { status: "success" },
      },
      {
        id: "pages-previous",
        created_on: "2026-06-09T12:00:00Z",
        environment: "production",
        latest_stage: { status: "success" },
      },
    ],
  },
};

const pages = summarizePagesDeployments(pagesPayload);
assert.equal(pages.current.deploymentId, "pages-current");
assert.equal(pages.previous.deploymentId, "pages-previous");

const manifest = buildCaptureManifest({
  git: { head: "abc123", branch: "main", dirty: false },
  worker,
  pages,
});
assert.match(manifest.rollbackHints.worker, /ver-previous/);
assert.equal(manifest.rollbackHints.verify, "npm run smoke:production");

console.log("capture deploy versions tests passed");