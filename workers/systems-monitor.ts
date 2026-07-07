export interface Env {
  MONITOR_ENDPOINT: string;
  CRON_SECRET: string;
}

const worker = {
  async scheduled(_event: unknown, env: Env) {
    // MONITOR_ENDPOINT must be the workers.dev ORIGIN (bearer-authed, in the origin-guard
    // PUBLIC_API_PREFIXES bypass) — NOT the studio.bythereeses.com proxy host, which
    // login-walls /api/cron/* (303 -> /admin/login 200). redirect:"manual" + a status check
    // make a misconfiguration fail LOUDLY in observability instead of silently "succeeding" on
    // a followed 303 (the exact 2-month incident this whole phase exists to prevent).
    const res = await fetch(env.MONITOR_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
      },
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || res.status < 200 || res.status >= 300) {
      throw new Error(
        `systems-monitor endpoint returned ${res.status} (${res.type}); monitor did NOT run. ` +
          `A redirect means MONITOR_ENDPOINT is login-walled — it must be the workers.dev origin.`,
      );
    }
  },
};

export default worker;
