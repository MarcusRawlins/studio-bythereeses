export interface Env {
  REMINDER_ENDPOINT: string;
  CRON_SECRET: string;
}

const worker = {
  async scheduled(_event: unknown, env: Env) {
    await fetch(env.REMINDER_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
      },
    });
  },
};

export default worker;
