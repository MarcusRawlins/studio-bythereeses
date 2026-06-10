import assert from "node:assert/strict";
import pagesProxyWorker from "./_worker.js";

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function unsignedIdToken(payload: Record<string, unknown>) {
  return [
    base64UrlEncode(JSON.stringify({ alg: "none" })),
    base64UrlEncode(JSON.stringify(payload)),
    "",
  ].join(".");
}

async function main() {
  const nonce = "admin-auth-nonce";
  const state = `admin.${base64UrlEncode(JSON.stringify({
    kind: "admin",
    nonce,
    nextPath: "/projects",
  }))}`;
  const fetchUrls: string[] = [];

  globalThis.fetch = (async (request: Request | string) => {
    const url = typeof request === "string" ? request : request.url;
    fetchUrls.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({
        access_token: "google-access-token",
        id_token: unsignedIdToken({ email: "attacker@example.com" }),
      });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json({ email: "hello@bythereeses.com" });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as never;

  const response = await pagesProxyWorker.fetch(
    new Request(`https://studio.bythereeses.com/api/google/callback?code=auth-code&state=${encodeURIComponent(state)}`, {
      headers: {
        cookie: `reese_studio_oauth_state=${nonce}`,
      },
    }),
    {
      ADMIN_SESSION_SECRET: "admin-session-secret",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
    },
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.bythereeses.com/projects");
  assert.ok(
    response.headers.get("set-cookie")?.includes("reese_studio_session="),
    "successful admin login should set the Studio session cookie",
  );
  assert.deepEqual(fetchUrls, [
    "https://oauth2.googleapis.com/token",
    "https://openidconnect.googleapis.com/v1/userinfo",
  ]);

  console.log("pages proxy admin auth tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
