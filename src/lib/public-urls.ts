export function publicScheduleBaseUrl() {
  return process.env.NEXT_PUBLIC_SCHEDULE_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}
