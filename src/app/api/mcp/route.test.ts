import assert from "node:assert/strict";

function request(body: unknown, token = "secret") {
  return new Request("https://studio.bythereeses.com/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  process.env.STUDIO_AGENT_API_TOKEN = "secret";
  const route = await import("./route");

  const initialized = await route.POST(request({
    jsonrpc: "2.0",
    id: "init-1",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-agent", version: "1.0.0" },
    },
  }));
  assert.equal(initialized.status, 200);
  assert.equal(initialized.headers.get("content-type")?.includes("application/json"), true);
  assert.equal((await initialized.json()).result.serverInfo.name, "the-reeses-studio");

  const notification = await route.POST(request({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }));
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");

  const unauthorized = await route.POST(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong"));
  assert.equal(unauthorized.status, 401);

  const missingStreamAccept = await route.POST(new Request("https://studio.bythereeses.com/api/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  }));
  assert.equal(missingStreamAccept.status, 406);

  const getResponse = await route.GET();
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get("allow"), "POST");

  console.log("mcp route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
