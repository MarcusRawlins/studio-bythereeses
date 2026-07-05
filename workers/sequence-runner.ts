export interface Env {
  SEQUENCES_ENDPOINT: string;
  CRON_SECRET: string;
}

const worker = {
  async scheduled(_event: unknown, env: Env) {
    // SEQUENCES_ENDPOINT must be the workers.dev ORIGIN (bearer-authed, in the
    // origin-guard PUBLIC_API_PREFIXES bypass) — NOT the studio.bythereeses.com
    // proxy host, which login-walls /api/cron/* (303 -> /admin/login 200).
    // redirect:"manual" + a status check make a misconfiguration fail LOUDLY in
    // observability instead of silently "succeeding" on a followed 303.
    // (Mirrors the FIXED workers/scheduler-reminders.ts — replicate the fix,
    // never the old redirect:"follow" shape that silently dropped every run.)
    const res = await fetch(env.SEQUENCES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
      },
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || res.status < 200 || res.status >= 300) {
      throw new Error(
        `sequence-runner endpoint returned ${res.status} (${res.type}); sequences NOT run. ` +
          `A redirect means SEQUENCES_ENDPOINT is login-walled — it must be the workers.dev origin.`,
      );
    }
  },
};

export default worker;
