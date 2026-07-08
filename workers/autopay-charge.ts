export interface Env {
  AUTOPAY_ENDPOINT: string;
  CRON_SECRET: string;
}

const worker = {
  async scheduled(_event: unknown, env: Env) {
    // AUTOPAY_ENDPOINT must be the workers.dev ORIGIN (bearer-authed, in the origin-guard
    // PUBLIC_API_PREFIXES bypass) — NOT the studio.bythereeses.com proxy host, which login-walls
    // /api/cron/* (303 -> /admin/login 200). redirect:"manual" + a status check make a
    // misconfiguration fail LOUDLY in observability instead of silently "succeeding" on a followed
    // 303. (Mirrors workers/sequence-runner.ts / workers/systems-monitor.ts — replicate the fix,
    // never a redirect:"follow" shape that silently drops every run.) The route no-ops (records ok +
    // skips) while AUTOPAY_ENABLED is dark, so wiring this early is safe and starts the heartbeat.
    const res = await fetch(env.AUTOPAY_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
      },
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || res.status < 200 || res.status >= 300) {
      throw new Error(
        `autopay-charge endpoint returned ${res.status} (${res.type}); autopay did NOT run. ` +
          `A redirect means AUTOPAY_ENDPOINT is login-walled — it must be the workers.dev origin.`,
      );
    }
  },
};

export default worker;
