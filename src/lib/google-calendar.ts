import { db } from "@/db/client";
import { googleCalendarConnections } from "@/db/schema";
import { eq, isNull } from "drizzle-orm";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

type BusyTime = {
  start: Date;
  end: Date;
};

export type GoogleCalendarListEntry = {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
  connectionId?: string;
  accountEmail?: string;
};

export type ConnectedGoogleCalendarAccount = {
  id: string;
  email: string;
  displayName: string | null;
  calendars: GoogleCalendarListEntry[];
};

type CalendarEventInput = {
  summary: string;
  description?: string;
  attendeeEmail: string;
  attendeeName: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  calendarId?: string | null;
  zoomJoinUrl?: string | null;
  createMeetLink?: boolean;
};

export type CalendarEventResult = {
  eventId: string;
  meetLink: string | null;
};

type AllDayCalendarEventInput = {
  summary: string;
  description?: string | null;
  date: string;
  calendarId?: string | null;
  location?: string | null;
};

type GoogleUserInfo = {
  email?: string;
  name?: string;
};

type CachedAccessToken = {
  token: string;
  expiresAt: number;
};

type CachedBusyTimes = {
  busyTimes: BusyTime[];
  expiresAt: number;
};

const accessTokenCache = new Map<string, CachedAccessToken>();
const busyTimesCache = new Map<string, CachedBusyTimes>();
const accessTokenCacheMs = 45 * 60 * 1000;
const busyTimesCacheMs = 2 * 60 * 1000;

function hasGoogleOAuthApp() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function googleCredentialsReady() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

function splitConnectedCalendarId(value: string | null | undefined) {
  if (!value) return { connectionId: null, calendarId: null };
  const [connectionId, ...calendarIdParts] = value.split("::");
  if (!calendarIdParts.length) return { connectionId: null, calendarId: value };
  return { connectionId, calendarId: calendarIdParts.join("::") };
}

function nextAllDayDate(dateValue: string) {
  const [year, month, day] = dateValue.split("-").map(Number);
  if (!year || !month || !day) return dateValue;

  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function connectedCalendarValue(connectionId: string, calendarId: string) {
  return `${connectionId}::${calendarId}`;
}

function tokenEncryptionKey() {
  const secret = process.env.SCHEDULER_LINK_SECRET || process.env.AUTH_SECRET || process.env.GOOGLE_CLIENT_SECRET || "local-calendar-token-secret";
  return createHash("sha256").update(secret).digest();
}

function encryptRefreshToken(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "enc:v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

function decryptRefreshToken(value: string) {
  if (!value.startsWith("enc:v1:")) return value;
  const [, , ivValue, tagValue, encryptedValue] = value.split(":");
  const decipher = createDecipheriv("aes-256-gcm", tokenEncryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function maybeDecryptRefreshToken(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    return decryptRefreshToken(value);
  } catch {
    return undefined;
  }
}

async function getAccessToken(refreshToken = process.env.GOOGLE_REFRESH_TOKEN) {
  if (!hasGoogleOAuthApp() || !refreshToken) return null;
  const cacheKey = createHash("sha256").update(refreshToken).digest("hex");
  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) return null;
  const data = await response.json() as { access_token?: string };
  if (data.access_token) {
    accessTokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + accessTokenCacheMs,
    });
  }
  return data.access_token ?? null;
}

async function getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo | null> {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  return response.json() as Promise<GoogleUserInfo>;
}

async function listCalendars(accessToken: string, connectionId?: string, accountEmail?: string): Promise<GoogleCalendarListEntry[]> {
  const response = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) return [];
  const data = await response.json() as {
    items?: Array<{
      id?: string;
      summary?: string;
      primary?: boolean;
      accessRole?: string;
    }>;
  };

  return (data.items ?? [])
    .filter((calendar) => calendar.id)
    .map((calendar) => ({
      id: calendar.id!,
      summary: calendar.summary || calendar.id!,
      primary: Boolean(calendar.primary),
      accessRole: calendar.accessRole || "reader",
      connectionId,
      accountEmail,
    }));
}

export function getGoogleCalendarStatus() {
  const calendarIds = process.env.GOOGLE_CALENDAR_IDS ?? "primary";
  const createCalendarId = process.env.GOOGLE_CALENDAR_ID ?? "primary";

  return {
    connected: googleCredentialsReady(),
    oauthAppReady: hasGoogleOAuthApp(),
    calendarIds,
    createCalendarId,
    missing: [
      !process.env.GOOGLE_CLIENT_ID && "GOOGLE_CLIENT_ID",
      !process.env.GOOGLE_CLIENT_SECRET && "GOOGLE_CLIENT_SECRET",
      !process.env.GOOGLE_REFRESH_TOKEN && "GOOGLE_REFRESH_TOKEN",
    ].filter(Boolean) as string[],
  };
}

export async function getConnectedGoogleAccounts(): Promise<ConnectedGoogleCalendarAccount[]> {
  const connections = await db.query.googleCalendarConnections.findMany({
    where: isNull(googleCalendarConnections.revokedAt),
  });

  const accounts = await Promise.all(connections.map(async (connection) => {
    const accessToken = await getAccessToken(maybeDecryptRefreshToken(connection.refreshToken));
    const calendars = accessToken
      ? await listCalendars(accessToken, connection.id, connection.googleAccountEmail)
      : [];

    return {
      id: connection.id,
      email: connection.googleAccountEmail,
      displayName: connection.displayName,
      calendars,
    };
  }));

  if (!accounts.length && googleCredentialsReady()) {
    const accessToken = await getAccessToken();
    const user = accessToken ? await getGoogleUserInfo(accessToken) : null;
    const id = "env-primary";
    return [{
      id,
      email: user?.email || "hello@bythereeses.com",
      displayName: user?.name || null,
      calendars: accessToken ? await listCalendars(accessToken, id, user?.email || "hello@bythereeses.com") : [],
    }];
  }

  return accounts;
}

export async function saveGoogleCalendarConnection(refreshToken: string, scope?: string | null) {
  const accessToken = await getAccessToken(refreshToken);
  if (!accessToken) throw new Error("Could not connect this Google account.");
  const user = await getGoogleUserInfo(accessToken);
  const email = user?.email?.toLowerCase();
  if (!email) throw new Error("Google did not return an account email.");

  const now = new Date().toISOString();
  const existing = await db.query.googleCalendarConnections.findFirst({
    where: eq(googleCalendarConnections.googleAccountEmail, email),
  });

  if (existing) {
    await db.update(googleCalendarConnections).set({
      displayName: user?.name || existing.displayName,
      refreshToken: encryptRefreshToken(refreshToken),
      scope: scope || existing.scope,
      revokedAt: null,
      updatedAt: now,
    }).where(eq(googleCalendarConnections.id, existing.id));
    return existing.id;
  }

  const id = crypto.randomUUID();
  await db.insert(googleCalendarConnections).values({
    id,
    googleAccountEmail: email,
    displayName: user?.name || null,
    refreshToken: encryptRefreshToken(refreshToken),
    scope: scope || null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function getGoogleCalendarList(): Promise<GoogleCalendarListEntry[]> {
  const accounts = await getConnectedGoogleAccounts();
  return accounts.flatMap((account) => account.calendars);
}

export async function getGoogleBusyTimes(startAt: Date, endAt: Date, calendarIds: string[], options?: { bypassCache?: boolean }) {
  const normalizedCalendarIds = [...calendarIds].sort();
  const cacheKey = [
    startAt.toISOString(),
    endAt.toISOString(),
    normalizedCalendarIds.join("|"),
  ].join("::");
  const cached = busyTimesCache.get(cacheKey);
  if (!options?.bypassCache && cached && cached.expiresAt > Date.now()) return cached.busyTimes;

  const selectedByConnection = new Map<string, string[]>();
  const legacyCalendarIds: string[] = [];

  for (const value of normalizedCalendarIds) {
    const { connectionId, calendarId } = splitConnectedCalendarId(value);
    if (connectionId && calendarId) {
      selectedByConnection.set(connectionId, [...(selectedByConnection.get(connectionId) ?? []), calendarId]);
    } else if (calendarId) {
      legacyCalendarIds.push(calendarId);
    }
  }

  const busyTimes: BusyTime[] = [];
  const connections = await db.query.googleCalendarConnections.findMany({
    where: isNull(googleCalendarConnections.revokedAt),
  });

  for (const connection of connections) {
    const selectedCalendarIds = selectedByConnection.get(connection.id) ?? [];
    if (!selectedCalendarIds.length) continue;
    const accessToken = await getAccessToken(maybeDecryptRefreshToken(connection?.refreshToken));
    if (!accessToken) continue;
    busyTimes.push(...await fetchBusyTimes(accessToken, startAt, endAt, selectedCalendarIds));
  }

  if (legacyCalendarIds.length) {
    const accessToken = await getAccessToken();
    if (accessToken) busyTimes.push(...await fetchBusyTimes(accessToken, startAt, endAt, legacyCalendarIds));
  }

  busyTimesCache.set(cacheKey, {
    busyTimes,
    expiresAt: Date.now() + busyTimesCacheMs,
  });
  return busyTimes;
}

async function fetchBusyTimes(accessToken: string, startAt: Date, endAt: Date, calendarIds: string[]) {
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: startAt.toISOString(),
      timeMax: endAt.toISOString(),
      items: calendarIds.map((id) => ({ id })),
    }),
  });

  if (!response.ok) return [];
  const data = await response.json() as {
    calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }> }>;
  };

  const busyTimes: BusyTime[] = [];
  for (const calendar of Object.values(data.calendars ?? {})) {
    for (const busy of calendar.busy ?? []) {
      if (busy.start && busy.end) {
        busyTimes.push({ start: new Date(busy.start), end: new Date(busy.end) });
      }
    }
  }
  return busyTimes;
}

export async function createGoogleCalendarEvent(input: CalendarEventInput) {
  const { connectionId, calendarId } = splitConnectedCalendarId(input.calendarId || process.env.GOOGLE_CALENDAR_ID || "primary");
  const connection = connectionId && connectionId !== "env-primary"
    ? await db.query.googleCalendarConnections.findFirst({ where: eq(googleCalendarConnections.id, connectionId) })
    : null;
  if (connectionId && connectionId !== "env-primary" && !connection) return null;
  const accessToken = await getAccessToken(maybeDecryptRefreshToken(connection?.refreshToken));
  if (!accessToken) return null;

  const targetCalendarId = calendarId || "primary";
  const description = [
    input.description,
    input.zoomJoinUrl ? `Zoom: ${input.zoomJoinUrl}` : null,
  ].filter(Boolean).join("\n\n");

  const eventsUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events?sendUpdates=all${input.createMeetLink ? "&conferenceDataVersion=1" : ""}`;

  const response = await fetch(eventsUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary: input.summary,
      description,
      location: input.zoomJoinUrl ?? undefined,
      start: {
        dateTime: input.startAt.toISOString(),
        timeZone: input.timezone,
      },
      end: {
        dateTime: input.endAt.toISOString(),
        timeZone: input.timezone,
      },
      attendees: [
        { email: input.attendeeEmail, displayName: input.attendeeName },
      ],
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 60 },
          { method: "popup", minutes: 15 },
        ],
      },
      ...(input.createMeetLink ? {
        conferenceData: {
          createRequest: {
            requestId: crypto.randomUUID(),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      } : {}),
    }),
  });

  if (!response.ok) return null;
  const data = await response.json() as {
    id?: string;
    hangoutLink?: string;
    conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  };
  if (!data.id) return null;

  const meetLink = data.hangoutLink
    ?? data.conferenceData?.entryPoints?.find((entryPoint) => entryPoint.entryPointType === "video")?.uri
    ?? null;

  return { eventId: data.id, meetLink };
}

export async function createGoogleCalendarAllDayEvent(input: AllDayCalendarEventInput) {
  const { connectionId, calendarId } = splitConnectedCalendarId(input.calendarId || process.env.GOOGLE_CALENDAR_ID || "primary");
  const connection = connectionId && connectionId !== "env-primary"
    ? await db.query.googleCalendarConnections.findFirst({ where: eq(googleCalendarConnections.id, connectionId) })
    : null;
  if (connectionId && connectionId !== "env-primary" && !connection) return null;
  const accessToken = await getAccessToken(maybeDecryptRefreshToken(connection?.refreshToken));
  if (!accessToken) return null;

  const targetCalendarId = calendarId || "primary";
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary: input.summary,
      description: input.description || undefined,
      location: input.location || undefined,
      start: {
        date: input.date,
      },
      end: {
        date: nextAllDayDate(input.date),
      },
      reminders: {
        useDefault: true,
      },
    }),
  });

  if (!response.ok) return null;
  const data = await response.json() as { id?: string };
  return data.id ?? null;
}

export async function updateGoogleCalendarAllDayEvent(input: AllDayCalendarEventInput & { eventId: string }) {
  const { connectionId, calendarId } = splitConnectedCalendarId(input.calendarId || process.env.GOOGLE_CALENDAR_ID || "primary");
  const connection = connectionId && connectionId !== "env-primary"
    ? await db.query.googleCalendarConnections.findFirst({ where: eq(googleCalendarConnections.id, connectionId) })
    : null;
  if (connectionId && connectionId !== "env-primary" && !connection) return null;
  const accessToken = await getAccessToken(maybeDecryptRefreshToken(connection?.refreshToken));
  if (!accessToken) return null;

  const targetCalendarId = calendarId || "primary";
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events/${encodeURIComponent(input.eventId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary: input.summary,
      description: input.description || undefined,
      location: input.location || undefined,
      start: {
        date: input.date,
      },
      end: {
        date: nextAllDayDate(input.date),
      },
      reminders: {
        useDefault: true,
      },
    }),
  });

  if (!response.ok) return null;
  const data = await response.json() as { id?: string };
  return data.id ?? input.eventId;
}

export async function deleteGoogleCalendarEvent(input: {
  calendarId?: string | null;
  eventId?: string | null;
}) {
  if (!input.eventId) return false;
  const { connectionId, calendarId } = splitConnectedCalendarId(input.calendarId || process.env.GOOGLE_CALENDAR_ID || "primary");
  const connection = connectionId && connectionId !== "env-primary"
    ? await db.query.googleCalendarConnections.findFirst({ where: eq(googleCalendarConnections.id, connectionId) })
    : null;
  if (connectionId && connectionId !== "env-primary" && !connection) return false;
  const accessToken = await getAccessToken(maybeDecryptRefreshToken(connection?.refreshToken));
  if (!accessToken) return false;

  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId || "primary")}/events/${encodeURIComponent(input.eventId)}?sendUpdates=all`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return response.ok || response.status === 410 || response.status === 404;
}
