import { db } from "@/db/client";
import { shootingLocations } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const locationStatuses = ["active", "needs_scouting", "archived"] as const;
const locationTypes = ["beach", "venue", "park", "estate", "garden", "urban", "waterfront", "mountain", "other"] as const;

function textValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function enumValue<T extends readonly string[]>(value: string, allowed: T, fallback: T[number]) {
  return allowed.includes(value as T[number]) ? value as T[number] : fallback;
}

function tagsJson(value: string) {
  const tags = value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return tags.length ? JSON.stringify([...new Set(tags)]) : null;
}

function safeRevalidatePath(path: string) {
  try {
    revalidatePath(path);
  } catch (error) {
    if (error instanceof Error && error.message.includes("static generation store missing")) return;
    throw error;
  }
}

export function parseShootingLocationTags(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

export async function listShootingLocations() {
  return db.query.shootingLocations.findMany({
    orderBy: [desc(shootingLocations.updatedAt)],
  });
}

export async function createShootingLocationFromForm(formData: FormData) {
  const name = textValue(formData, "name");
  if (!name) throw new Error("Location name is required.");

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db.insert(shootingLocations).values({
    id,
    name,
    region: textValue(formData, "region") || null,
    city: textValue(formData, "city") || null,
    state: textValue(formData, "state") || null,
    country: textValue(formData, "country") || "USA",
    address: textValue(formData, "address") || null,
    googleMapsUrl: textValue(formData, "googleMapsUrl") || null,
    locationType: enumValue(textValue(formData, "locationType"), locationTypes, "other"),
    bestFor: textValue(formData, "bestFor") || null,
    permitNotes: textValue(formData, "permitNotes") || null,
    accessNotes: textValue(formData, "accessNotes") || null,
    lightNotes: textValue(formData, "lightNotes") || null,
    droneNotes: textValue(formData, "droneNotes") || null,
    generalNotes: textValue(formData, "generalNotes") || null,
    tagsJson: tagsJson(textValue(formData, "tags")),
    status: enumValue(textValue(formData, "status"), locationStatuses, "active"),
    createdAt: now,
    updatedAt: now,
  });

  await logActivity({ action: "shooting_location.created", metadata: { id, name } });
  safeRevalidatePath("/shooting-locations");
  return { id };
}

export async function updateShootingLocationFromForm(formData: FormData) {
  const id = textValue(formData, "locationId");
  const name = textValue(formData, "name");
  if (!id || !name) throw new Error("Location and name are required.");

  await db.update(shootingLocations).set({
    name,
    region: textValue(formData, "region") || null,
    city: textValue(formData, "city") || null,
    state: textValue(formData, "state") || null,
    country: textValue(formData, "country") || "USA",
    address: textValue(formData, "address") || null,
    googleMapsUrl: textValue(formData, "googleMapsUrl") || null,
    locationType: enumValue(textValue(formData, "locationType"), locationTypes, "other"),
    bestFor: textValue(formData, "bestFor") || null,
    permitNotes: textValue(formData, "permitNotes") || null,
    accessNotes: textValue(formData, "accessNotes") || null,
    lightNotes: textValue(formData, "lightNotes") || null,
    droneNotes: textValue(formData, "droneNotes") || null,
    generalNotes: textValue(formData, "generalNotes") || null,
    tagsJson: tagsJson(textValue(formData, "tags")),
    status: enumValue(textValue(formData, "status"), locationStatuses, "active"),
    updatedAt: new Date().toISOString(),
  }).where(eq(shootingLocations.id, id));

  await logActivity({ action: "shooting_location.updated", metadata: { id, name } });
  safeRevalidatePath("/shooting-locations");
  return { id };
}

export async function archiveShootingLocationFromForm(formData: FormData) {
  const id = textValue(formData, "locationId");
  if (!id) throw new Error("Location is required.");

  await db.update(shootingLocations).set({
    status: "archived",
    updatedAt: new Date().toISOString(),
  }).where(eq(shootingLocations.id, id));

  await logActivity({ action: "shooting_location.archived", metadata: { id } });
  safeRevalidatePath("/shooting-locations");
  return { id };
}
