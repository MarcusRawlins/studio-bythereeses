import { createProjectGallery, deleteProjectGallery, updateProjectGallery } from "@/lib/gallery";
import { redirect } from "next/navigation";

// FOOTGUN GUARD: this module deliberately mixes plain exported `*FromForm`
// helpers (invoked server-side only) with per-function inline `"use server"`
// actions below. Do NOT add a module-level top-of-file `"use server"`
// directive — it would silently turn EVERY export (including the non-action
// `*FromForm` helpers) into a client-callable server action, widening the
// attack surface. Keep `"use server"` scoped to the individual `*Action`
// functions.
//
// Thin FormData adapters over the canonical src/lib/gallery.ts mutations —
// mirrors the `*FromForm` pattern in src/lib/crm.ts (e.g.
// `addProjectLocationFromForm` / `updateProjectLocationFromForm`). All
// validation, activity logging, and revalidation live in gallery.ts so the
// admin form and the agent tool cannot diverge on URL safety.

function textValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function nullableTextValue(formData: FormData, key: string) {
  return textValue(formData, key) || null;
}

export async function createProjectGalleryFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  await createProjectGallery({
    projectId,
    title: textValue(formData, "title"),
    url: textValue(formData, "url"),
    provider: nullableTextValue(formData, "provider"),
    status: nullableTextValue(formData, "status"),
    passcode: nullableTextValue(formData, "passcode"),
    expiresAt: nullableTextValue(formData, "expiresAt"),
    actorType: "admin",
    actorName: "Tyler",
  });
  return projectId;
}

export async function updateProjectGalleryFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const galleryId = textValue(formData, "galleryId");
  await updateProjectGallery({
    projectId,
    galleryId,
    title: textValue(formData, "title"),
    url: textValue(formData, "url"),
    provider: nullableTextValue(formData, "provider"),
    status: nullableTextValue(formData, "status"),
    passcode: nullableTextValue(formData, "passcode"),
    expiresAt: nullableTextValue(formData, "expiresAt"),
    actorType: "admin",
    actorName: "Tyler",
  });
  return projectId;
}

export async function deleteProjectGalleryFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const galleryId = textValue(formData, "galleryId");
  await deleteProjectGallery({
    projectId,
    galleryId,
    actorType: "admin",
    actorName: "Tyler",
  });
  return projectId;
}

// "use server" actions bound directly to <form action={...}> in
// ProjectGalleryForm.tsx — mirrors `updateProjectAction` in src/lib/crm.ts
// (used by ProjectEditForm.tsx).

export async function createProjectGalleryAction(formData: FormData) {
  "use server";

  const projectId = await createProjectGalleryFromForm(formData);
  redirect(`/projects/${projectId}`);
}

export async function updateProjectGalleryAction(formData: FormData) {
  "use server";

  const projectId = await updateProjectGalleryFromForm(formData);
  redirect(`/projects/${projectId}`);
}

export async function deleteProjectGalleryAction(formData: FormData) {
  "use server";

  const projectId = await deleteProjectGalleryFromForm(formData);
  redirect(`/projects/${projectId}`);
}
