import assert from "node:assert/strict";
import worker, { type Env } from "./inquiry-intake";

// Phase 8a B3 — no silent drops. Every exit path of the email() handler must
// forward the message to INTAKE_FALLBACK: flag-off, oversize, endpoint non-2xx,
// and thrown/network error. setReject must never be called.

const FALLBACK = "fallback@bythereeses.com";

function baseEnv(overrides?: Partial<Env>): Env {
  return {
    INTAKE_ENDPOINT: "https://studio.test/api/inbound/inquiry-email",
    INBOUND_INTAKE_SECRET: "secret",
    INTAKE_ENABLED: "true",
    INTAKE_FALLBACK: FALLBACK,
    ...overrides,
  };
}

function fakeMessage(opts?: { rawSize?: number; raw?: string }) {
  const forwards: string[] = [];
  const rejects: string[] = [];
  const raw = opts?.raw ?? "Content-Type: text/plain\n\nHello";
  const message = {
    from: "jane@example.com",
    to: "inquiries@bythereeses.com",
    headers: new Headers({
      from: '"Jane" <jane@example.com>',
      subject: "Hi",
      "message-id": "<m-1@example.com>",
      "authentication-results": "mx; spf=pass",
    }),
    rawSize: opts?.rawSize ?? raw.length,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    }),
    async forward(rcptTo: string) {
      forwards.push(rcptTo);
    },
    setReject(reason: string) {
      rejects.push(reason);
    },
  };
  return { message, forwards, rejects };
}

async function main() {
  const originalFetch = global.fetch;

  // ---- flag OFF → forward, never drop, never setReject ----
  {
    const { message, forwards, rejects } = fakeMessage();
    await worker.email(message as never, baseEnv({ INTAKE_ENABLED: "false" }));
    assert.deepEqual(forwards, [FALLBACK], "flag off forwards to fallback");
    assert.equal(rejects.length, 0, "flag off never setRejects");
  }

  // ---- oversize → forward (not setReject) ----
  {
    const { message, forwards, rejects } = fakeMessage({ rawSize: 5_000_000 });
    await worker.email(message as never, baseEnv());
    assert.deepEqual(forwards, [FALLBACK], "oversize forwards to fallback");
    assert.equal(rejects.length, 0, "oversize never setRejects (it is a lead)");
  }

  // ---- endpoint non-2xx (e.g. flag-off 503) → forward ----
  {
    global.fetch = async () => new Response("nope", { status: 503 });
    const { message, forwards } = fakeMessage();
    await worker.email(message as never, baseEnv());
    assert.deepEqual(forwards, [FALLBACK], "endpoint non-2xx forwards to fallback");
  }

  // ---- endpoint 2xx → NO forward (persisted safely) ----
  {
    let posted = false;
    global.fetch = async () => {
      posted = true;
      return new Response(JSON.stringify({ id: "x", deduped: false }), { status: 200 });
    };
    const { message, forwards } = fakeMessage();
    await worker.email(message as never, baseEnv());
    assert.equal(posted, true, "endpoint was called");
    assert.equal(forwards.length, 0, "2xx does not forward");
  }

  // ---- proxy login-wall 303 (redirect NOT followed) → forward (Fable B1) ----
  // Models the exact regression: the proxy 303s an unauth POST to /admin/login.
  // With redirect:"manual" the Worker sees the 3xx and must NOT treat it as
  // persisted.
  {
    let captured: RequestInit | undefined;
    global.fetch = async (_url: unknown, init?: RequestInit) => {
      captured = init;
      return new Response(null, { status: 303, headers: { location: "/admin/login" } });
    };
    const { message, forwards } = fakeMessage();
    await worker.email(message as never, baseEnv());
    assert.equal(captured?.redirect, "manual", "fetch must use redirect:manual so a 303 is not followed");
    assert.deepEqual(forwards, [FALLBACK], "303 redirect forwards to fallback (not a silent drop)");
  }

  // ---- a FOLLOWED redirect that landed on a 200 login page → forward ----
  // Belt-and-suspenders: even if some future runtime follows to the 200 login
  // PAGE (res.redirected === true), the Worker must still forward, never mistake
  // it for a persisted lead.
  {
    global.fetch = async () =>
      ({ ok: true, status: 200, redirected: true, type: "default" } as unknown as Response);
    const { message, forwards } = fakeMessage();
    await worker.email(message as never, baseEnv());
    assert.deepEqual(forwards, [FALLBACK], "followed-redirect 200 forwards to fallback");
  }

  // ---- opaqueredirect response → forward ----
  {
    global.fetch = async () =>
      ({ ok: false, status: 0, redirected: false, type: "opaqueredirect" } as unknown as Response);
    const { message, forwards } = fakeMessage();
    await worker.email(message as never, baseEnv());
    assert.deepEqual(forwards, [FALLBACK], "opaqueredirect forwards to fallback");
  }

  // ---- thrown / network error → forward ----
  {
    global.fetch = async () => {
      throw new Error("network down");
    };
    const { message, forwards } = fakeMessage();
    await worker.email(message as never, baseEnv());
    assert.deepEqual(forwards, [FALLBACK], "thrown error forwards to fallback");
  }

  global.fetch = originalFetch;
  console.log("inquiry intake worker no-silent-drop tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
