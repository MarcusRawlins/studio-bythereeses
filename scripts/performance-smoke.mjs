const scheduleBaseUrl = process.env.SMOKE_SCHEDULE_URL || "https://schedule.bythereeses.com";
const studioBaseUrl = process.env.SMOKE_STUDIO_URL || "https://studio.bythereeses.com";
const bookingSlug = process.env.SMOKE_BOOKING_SLUG || "wedding-photography-discovery-call";
const maxWarmBookingMs = Number(process.env.SMOKE_MAX_WARM_BOOKING_MS || 750);
const maxStudioRedirectMs = Number(process.env.SMOKE_MAX_STUDIO_REDIRECT_MS || 500);

function now() {
  return performance.now();
}

async function timedFetch(url, init = {}) {
  const start = now();
  const response = await fetch(url, {
    redirect: "manual",
    headers: {
      "accept-encoding": "br, gzip, deflate",
      ...(init.headers || {}),
    },
    ...init,
  });
  const body = await response.arrayBuffer();
  return {
    url,
    status: response.status,
    elapsedMs: Math.round(now() - start),
    bytes: body.byteLength,
    cache: response.headers.get("x-reese-cache") || response.headers.get("cf-cache-status") || "n/a",
    location: response.headers.get("location"),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function printResult(label, result) {
  console.log(`${label}: status=${result.status} time=${result.elapsedMs}ms bytes=${result.bytes} cache=${result.cache}`);
  if (result.location) console.log(`${label}: location=${result.location}`);
}

const bookingUrl = `${scheduleBaseUrl.replace(/\/$/, "")}/book/${bookingSlug}?date=2026-05-19`;
const scheduleRootUrl = `${scheduleBaseUrl.replace(/\/$/, "")}/`;
const studioUrl = `${studioBaseUrl.replace(/\/$/, "")}/`;

const scheduleRoot = await timedFetch(scheduleRootUrl);
printResult("schedule root redirect", scheduleRoot);
assert(scheduleRoot.status === 303, `Expected schedule root to redirect with 303, got ${scheduleRoot.status}`);
assert(scheduleRoot.location?.includes(`/book/${bookingSlug}`), `Expected schedule root redirect to booking page, got ${scheduleRoot.location || "no location"}`);

const firstBooking = await timedFetch(bookingUrl);
printResult("booking cold/warmup", firstBooking);
assert(firstBooking.status === 200, `Expected booking page status 200, got ${firstBooking.status}`);

const secondBooking = await timedFetch(bookingUrl);
printResult("booking warm", secondBooking);
assert(secondBooking.status === 200, `Expected warm booking page status 200, got ${secondBooking.status}`);
assert(secondBooking.elapsedMs <= maxWarmBookingMs, `Warm booking page took ${secondBooking.elapsedMs}ms, over ${maxWarmBookingMs}ms`);
assert(["HIT", "MISS"].includes(secondBooking.cache), `Expected booking cache header HIT or MISS, got ${secondBooking.cache}`);

const studioRedirect = await timedFetch(studioUrl);
printResult("studio auth redirect", studioRedirect);
assert(studioRedirect.status === 303, `Expected Studio to redirect unauthenticated users with 303, got ${studioRedirect.status}`);
assert(studioRedirect.location?.includes("/admin/login"), `Expected Studio redirect to /admin/login, got ${studioRedirect.location || "no location"}`);
assert(studioRedirect.elapsedMs <= maxStudioRedirectMs, `Studio redirect took ${studioRedirect.elapsedMs}ms, over ${maxStudioRedirectMs}ms`);

console.log("performance smoke checks passed");
