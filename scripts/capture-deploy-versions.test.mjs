import assert from "node:assert/strict";
import {
  buildCaptureManifest,
  normalizeDeploymentList,
  summarizePagesDeployments,
  summarizeWorkerDeployments,
} from "./capture-deploy-versions.mjs";

const workerPayload = [
  {
    id: "dep-oldest",
    created_on: "2026-06-08T12:00:00Z",
    versions: [{ version_id: "ver-oldest", percentage: 100 }],
  },
  {
    id: "dep-previous",
    created_on: "2026-06-09T12:00:00Z",
    versions: [{ version_id: "ver-previous", percentage: 100 }],
  },
  {
    id: "dep-current",
    created_on: "2026-06-10T12:00:00Z",
    versions: [{ version_id: "ver-current", percentage: 100 }],
  },
];

assert.deepEqual(normalizeDeploymentList(workerPayload), workerPayload);
assert.deepEqual(normalizeDeploymentList({ result: { deployments: workerPayload } }), workerPayload);

const worker = summarizeWorkerDeployments(workerPayload);
assert.equal(worker.current.versionId, "ver-current");
assert.equal(worker.previous.versionId, "ver-previous");
assert.equal(worker.all.length, 3);

const pagesPayload = {
  result: {
    deployments: [
      {
        Id: "pages-previous",
        CreatedOn: "2026-06-09T12:00:00Z",
        Environment: "Production",
        Deployment: "https://pages-previous.example.com",
        Status: "success",
      },
      {
        Id: "pages-current",
        CreatedOn: "2026-06-10T12:00:00Z",
        Environment: "Production",
        Deployment: "https://pages-current.example.com",
        Status: "success",
      },
    ],
  },
};

const pages = summarizePagesDeployments(pagesPayload);
assert.equal(pages.current.deploymentId, "pages-current");
assert.equal(pages.previous.deploymentId, "pages-previous");
assert.equal(pages.current.url, "https://pages-current.example.com");

const manifest = buildCaptureManifest({
  git: { head: "abc123", branch: "main", dirty: false },
  worker,
  pages,
});
assert.match(manifest.rollbackHints.worker, /ver-previous/);
assert.equal(manifest.rollbackHints.verify, "npm run smoke:production");

console.log("capture deploy versions tests passed");
