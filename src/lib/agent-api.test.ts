import assert from "node:assert/strict";
import { guardAgentApiRequest } from "./agent-api";

const previousToken = process.env.STUDIO_AGENT_API_TOKEN;

function requestWithToken(token?: string) {
  return new Request("https://studio.bythereeses.com/api/agent/projects/project-1/timeline", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

delete process.env.STUDIO_AGENT_API_TOKEN;

async function main() {
  assert.equal((await guardAgentApiRequest(requestWithToken("anything")))?.status, 503);

  process.env.STUDIO_AGENT_API_TOKEN = "studio-secret";
  assert.equal((await guardAgentApiRequest(requestWithToken()))?.status, 401);
  assert.equal((await guardAgentApiRequest(requestWithToken("wrong")))?.status, 401);
  assert.equal(await guardAgentApiRequest(requestWithToken("studio-secret")), null);

  if (previousToken === undefined) {
    delete process.env.STUDIO_AGENT_API_TOKEN;
  } else {
    process.env.STUDIO_AGENT_API_TOKEN = previousToken;
  }

  console.log("agent api tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
