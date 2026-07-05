import { db } from "@/db/client";
import { projectGalleries, projects, type ProjectGallery } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

// Phase 7a: provider-agnostic gallery delivery links. This module owns ALL
// gallery validation + canonical mutation so a second caller (admin form,
// agent tool) cannot bypass URL safety or the draft/attach-only agent
// authority guard. Mirrors how src/lib/portal.ts centralizes portal-token
// logic.

export const GALLERY_STATUSES = ["draft", "delivered", "archived"] as const;
export type GalleryStatus = (typeof GALLERY_STATUSES)[number];

const GALLERY_STATUS_SET = new Set<string>(GALLERY_STATUSES);

const MAX_GALLERY_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;
const MAX_PROVIDER_LENGTH = 80;
const MAX_PASSCODE_LENGTH = 200;
const MAX_EXPIRES_AT_LENGTH = 40;

// ---------------------------------------------------------------------------
// URL validation / normalization (§4.1) — the core XSS/injection defense.
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes an admin-pasted gallery delivery URL. Throws a
 * user-facing Error on any rejection. Rules:
 *   1. Trim; cap length at 2048 chars.
 *   2. Parse with the WHATWG `URL` constructor (rejects unparseable input).
 *   3. Require `parsed.protocol === "https:"` exactly — never a raw-string
 *      prefix check. The URL parser canonicalizes scheme casing and strips
 *      leading/embedded whitespace and tab characters, so `JaVaScRiPt:…`,
 *      `  javascript:…`, and `java\tscript:…` all normalize to a rejected
 *      non-https protocol here, whereas a naive `raw.startsWith("https")`
 *      could be fooled.
 *   4. Reject credentials embedded in the URL (`user:pass@host`).
 *   5. Require a non-empty host containing a dot (rejects `https://localhost`
 *      and bare hostnames).
 * Only the normalized `url.toString()` is ever stored.
 */
export function normalizeGalleryUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    throw new Error("Gallery URL is required.");
  }
  if (trimmed.length > MAX_GALLERY_URL_LENGTH) {
    throw new Error("Gallery URL is too long.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Gallery URL is not a valid URL.");
  }

  // Precise protocol comparison — see doc comment above. Do NOT change this to
  // a string prefix check on `raw`/`trimmed`.
  if (parsed.protocol !== "https:") {
    throw new Error("Gallery URL must start with https://.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Gallery URL must not include embedded credentials.");
  }

  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    throw new Error("Gallery URL must have a valid host.");
  }

  return parsed.toString();
}

/**
 * Belt-and-suspenders re-check used at render time (portal shaper, MCP
 * context) so even a hand-edited D1 row can never surface a non-https URL.
 */
export function isGalleryUrlSafe(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Optional provider-host allowlist (§4.2) — soft, non-blocking hint only.
// ---------------------------------------------------------------------------

const KNOWN_GALLERY_HOSTS: Record<string, string> = {
  "pixieset.com": "Pixieset",
  "pic-time.com": "Pic-Time",
  "cloudinary.com": "Cloudinary",
};

/**
 * Maps a gallery URL's host to a known provider label, or `null` for an
 * unrecognized/custom host. Never throws and never rejects — 7a is
 * provider-agnostic and studios may use a custom domain.
 */
export function inferProviderLabel(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [suffix, label] of Object.entries(KNOWN_GALLERY_HOSTS)) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return label;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function capOptionalText(value: string | null | undefined, label: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new Error(`${label} is too long.`);
  }
  return trimmed;
}

function capRequiredText(value: string | null | undefined, label: string, maxLength: number): string {
  const trimmed = capOptionalText(value, label, maxLength);
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function normalizeGalleryStatus(value: string | null | undefined): GalleryStatus {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return "draft";
  if (!GALLERY_STATUS_SET.has(trimmed)) {
    throw new Error("Gallery status must be draft, delivered, or archived.");
  }
  return trimmed as GalleryStatus;
}

function normalizeCreatedBy(value: string | null | undefined): "admin" | "agent" {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed === "agent" ? "agent" : "admin";
}

/**
 * `expiresAt` is admin/provider-supplied free text ("available until…").
 * Cap length, require it to parse as a date, and normalize to an ISO string
 * before storing — never persist arbitrary unparseable text into a field the
 * portal renders directly.
 */
function normalizeExpiresAt(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_EXPIRES_AT_LENGTH) {
    throw new Error("Expiration is too long.");
  }
  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) {
    throw new Error("Expiration must be a valid date.");
  }
  return new Date(parsedMs).toISOString();
}

function hasOwn(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function safeRevalidatePath(path: string) {
  try {
    revalidatePath(path);
  } catch (error) {
    if (error instanceof Error && error.message.includes("static generation store missing")) {
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Canonical mutations (§5.3) — called by admin server actions AND the
// optional agent attach tool. Activity-logged; timestamps set explicitly as
// ISO strings (never the SQL CURRENT_TIMESTAMP default).
// ---------------------------------------------------------------------------

export type CreateProjectGalleryInput = {
  projectId: string;
  title: string;
  url: string;
  provider?: string | null;
  status?: string | null;
  passcode?: string | null;
  expiresAt?: string | null;
  createdBy?: string | null;
  actorType?: "admin" | "agent";
  actorName?: string | null;
};

export async function createProjectGallery(input: CreateProjectGalleryInput): Promise<ProjectGallery> {
  const projectId = (input.projectId ?? "").trim();
  if (!projectId) {
    throw new Error("Project is required.");
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) {
    throw new Error("Project not found.");
  }

  const title = capRequiredText(input.title, "Gallery title", MAX_TITLE_LENGTH);
  const url = normalizeGalleryUrl(input.url);
  const provider = capOptionalText(input.provider, "Provider", MAX_PROVIDER_LENGTH) ?? inferProviderLabel(url);
  const status = normalizeGalleryStatus(input.status);
  const passcode = capOptionalText(input.passcode, "Passcode", MAX_PASSCODE_LENGTH);
  const expiresAt = normalizeExpiresAt(input.expiresAt);
  const createdBy = normalizeCreatedBy(input.createdBy);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  // deliveredAt is server-controlled: set the first time status is/becomes
  // "delivered", never taken from caller input.
  const deliveredAt = status === "delivered" ? now : null;

  await db.insert(projectGalleries).values({
    id,
    projectId,
    provider,
    title,
    url,
    status,
    passcode,
    deliveredAt,
    expiresAt,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });

  const gallery = await db.query.projectGalleries.findFirst({ where: eq(projectGalleries.id, id) });
  if (!gallery) {
    throw new Error("Gallery not found after creation.");
  }

  await logActivity({
    projectId,
    action: "gallery.created",
    actorType: input.actorType ?? (createdBy === "agent" ? "agent" : "admin"),
    actorName: input.actorName,
    metadata: { galleryId: id, status, provider },
  });

  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  safeRevalidatePath("/portal");

  return gallery;
}

export type UpdateProjectGalleryInput = {
  galleryId: string;
  projectId: string;
  title?: string;
  url?: string;
  provider?: string | null;
  status?: string | null;
  passcode?: string | null;
  expiresAt?: string | null;
  actorType?: "admin" | "agent";
  actorName?: string | null;
};

export async function updateProjectGallery(input: UpdateProjectGalleryInput): Promise<ProjectGallery> {
  const projectId = (input.projectId ?? "").trim();
  const galleryId = (input.galleryId ?? "").trim();
  if (!projectId || !galleryId) {
    throw new Error("Project and gallery are required.");
  }

  const existing = await db.query.projectGalleries.findFirst({ where: eq(projectGalleries.id, galleryId) });
  if (!existing || existing.projectId !== projectId) {
    throw new Error("Gallery not found.");
  }

  const title = hasOwn(input, "title") ? capRequiredText(input.title, "Gallery title", MAX_TITLE_LENGTH) : existing.title;
  const url = hasOwn(input, "url") ? normalizeGalleryUrl(input.url ?? "") : existing.url;
  const provider = hasOwn(input, "provider") ? capOptionalText(input.provider, "Provider", MAX_PROVIDER_LENGTH) : existing.provider;
  const status = hasOwn(input, "status") ? normalizeGalleryStatus(input.status) : (existing.status as GalleryStatus);
  const passcode = hasOwn(input, "passcode") ? capOptionalText(input.passcode, "Passcode", MAX_PASSCODE_LENGTH) : existing.passcode;
  const expiresAt = hasOwn(input, "expiresAt") ? normalizeExpiresAt(input.expiresAt) : existing.expiresAt;

  // deliveredAt is server-controlled and NEVER read from `input` — this
  // function has no `deliveredAt` field at all. Set once, the first time
  // status transitions to "delivered"; stable across every later edit.
  const deliveredAt = status === "delivered" && !existing.deliveredAt
    ? new Date().toISOString()
    : existing.deliveredAt;

  const updatedAt = new Date().toISOString();

  await db
    .update(projectGalleries)
    .set({ title, url, provider, status, passcode, expiresAt, deliveredAt, updatedAt })
    .where(eq(projectGalleries.id, galleryId));

  const updated = await db.query.projectGalleries.findFirst({ where: eq(projectGalleries.id, galleryId) });
  if (!updated) {
    throw new Error("Gallery not found after update.");
  }

  await logActivity({
    projectId,
    action: "gallery.updated",
    actorType: input.actorType,
    actorName: input.actorName,
    metadata: { galleryId, status, provider },
  });

  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  safeRevalidatePath("/portal");

  return updated;
}

export type DeleteProjectGalleryInput = {
  galleryId: string;
  projectId: string;
  actorType?: "admin" | "agent";
  actorName?: string | null;
};

export async function deleteProjectGallery(input: DeleteProjectGalleryInput): Promise<void> {
  const projectId = (input.projectId ?? "").trim();
  const galleryId = (input.galleryId ?? "").trim();
  if (!projectId || !galleryId) {
    throw new Error("Project and gallery are required.");
  }

  const existing = await db.query.projectGalleries.findFirst({ where: eq(projectGalleries.id, galleryId) });
  if (!existing || existing.projectId !== projectId) {
    throw new Error("Gallery not found.");
  }

  await db.delete(projectGalleries).where(eq(projectGalleries.id, galleryId));

  await logActivity({
    projectId,
    action: "gallery.deleted",
    actorType: input.actorType,
    actorName: input.actorName,
    metadata: { galleryId, status: existing.status, provider: existing.provider },
  });

  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  safeRevalidatePath("/portal");
}

// ---------------------------------------------------------------------------
// Optional agent tool (§5.4) — draft/attach-only. Forces status="draft" and
// createdBy="agent" REGARDLESS of the caller-supplied `input`: the hostile
// fields (`status`, `createdBy`) are never read from `input` below, they are
// hardcoded, so an agent can never mint a client-visible ("delivered")
// gallery no matter what a hostile/elevated request body contains.
// ---------------------------------------------------------------------------

export type AgentGalleryAttachInput = {
  title?: string | null;
  url?: string | null;
  provider?: string | null;
  passcode?: string | null;
  expiresAt?: string | null;
  // Accepted (so a permissive JSON body doesn't fail schema validation) but
  // deliberately IGNORED — see the hardcoded values passed to
  // createProjectGallery below.
  status?: string | null;
  createdBy?: string | null;
};

export async function attachProjectGalleryFromAgent(
  projectId: string,
  input: AgentGalleryAttachInput,
): Promise<ProjectGallery> {
  return createProjectGallery({
    projectId,
    title: input.title ?? "",
    url: input.url ?? "",
    provider: input.provider,
    passcode: input.passcode,
    expiresAt: input.expiresAt,
    status: "draft",
    createdBy: "agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
  });
}
