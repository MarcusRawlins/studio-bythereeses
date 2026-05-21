import { db } from "@/db/client";
import { clients, portalAccessTokens, projectParticipants, projects } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { and, eq, isNull } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { createHash, randomBytes } from "node:crypto";

const PORTAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function portalBaseUrl() {
  return process.env.PORTAL_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export async function generatePortalLink(projectId: string, clientId?: string | null) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const tokenRecordId = crypto.randomUUID();
  await db.insert(portalAccessTokens).values({
    id: tokenRecordId,
    projectId,
    clientId,
    tokenHash,
    label: "Client portal link",
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
  });

  await logActivity({
    projectId,
    clientId,
    action: "portal_token.generated",
    metadata: { tokenRecordId, expiresAt: expiresAt.toISOString() },
  });

  return `${portalBaseUrl()}/p/${token}`;
}

export async function authenticatePortalToken(token: string) {
  const hashed = hashToken(token);
  const tokenRecord = await db.query.portalAccessTokens.findFirst({
    where: eq(portalAccessTokens.tokenHash, hashed),
  });

  if (!tokenRecord || tokenRecord.revokedAt || new Date(tokenRecord.expiresAt) < new Date()) {
    return { ok: false as const, reason: "invalid" };
  }

  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

  await db
    .update(portalAccessTokens)
    .set({ lastUsedAt: new Date().toISOString(), lastUsedIp: ip })
    .where(eq(portalAccessTokens.id, tokenRecord.id));

  const cookieStore = await cookies();
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: PORTAL_COOKIE_MAX_AGE,
    path: "/",
  };
  cookieStore.set("portal_project_id", tokenRecord.projectId, cookieOptions);
  cookieStore.set("portal_token_id", tokenRecord.id, cookieOptions);

  await logActivity({
    projectId: tokenRecord.projectId,
    clientId: tokenRecord.clientId,
    action: "portal.login",
    actorType: "client",
    actorName: "Client",
  });

  return { ok: true as const, projectId: tokenRecord.projectId };
}

export async function clearPortalSession() {
  const cookieStore = await cookies();
  cookieStore.delete("portal_project_id");
  cookieStore.delete("portal_token_id");
}

export async function revokePortalToken(tokenId: string) {
  const token = await db.query.portalAccessTokens.findFirst({
    where: eq(portalAccessTokens.id, tokenId),
  });
  if (!token) return;
  await db
    .update(portalAccessTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(portalAccessTokens.id, tokenId));
  await logActivity({
    projectId: token.projectId,
    clientId: token.clientId,
    action: "portal_token.revoked",
    metadata: { tokenId },
  });
}

export async function requirePortalProject() {
  const cookieStore = await cookies();
  const projectId = cookieStore.get("portal_project_id")?.value;
  const tokenId = cookieStore.get("portal_token_id")?.value;

  if (!projectId || !tokenId) return null;

  const token = await db.query.portalAccessTokens.findFirst({
    where: and(
      eq(portalAccessTokens.id, tokenId),
      eq(portalAccessTokens.projectId, projectId),
      isNull(portalAccessTokens.revokedAt),
    ),
  });

  if (!token || new Date(token.expiresAt) < new Date()) {
    return null;
  }

  const rows = await db
    .select({
      project: projects,
      client: clients,
    })
    .from(projectParticipants)
    .innerJoin(projects, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projects.id, projectId));

  if (!rows.length) return null;

  await logActivity({
    projectId,
    clientId: token.clientId,
    action: "portal.project_viewed",
    actorType: "client",
    actorName: rows[0].client.preferredName ?? rows[0].client.firstName,
  });

  return {
    project: rows[0].project,
    clients: rows.map((row) => row.client),
    token,
  };
}
