import { db } from "@/db/client";
import { templates } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const templateTypes = ["email", "questionnaire", "contract", "workflow"] as const;

function textValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function templateTypeValue(value: FormDataEntryValue | null) {
  const type = String(value ?? "email");
  return templateTypes.includes(type as (typeof templateTypes)[number]) ? type : "email";
}

export async function listTemplates() {
  return db.query.templates.findMany({
    orderBy: desc(templates.createdAt),
  });
}

export async function createTemplateAction(formData: FormData) {
  "use server";

  const name = textValue(formData, "name");
  const body = textValue(formData, "body");

  if (!name || !body) {
    throw new Error("Template name and body are required.");
  }

  await db.insert(templates).values({
    id: crypto.randomUUID(),
    type: templateTypeValue(formData.get("type")),
    name,
    trigger: textValue(formData, "trigger") || null,
    subject: textValue(formData, "subject") || null,
    body,
    status: textValue(formData, "status") || "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await logActivity({
    action: "template.created",
    metadata: { name },
  });

  revalidatePath("/templates");
  redirect("/templates");
}

export async function updateTemplateAction(formData: FormData) {
  "use server";

  const id = textValue(formData, "templateId");
  const name = textValue(formData, "name");
  const body = textValue(formData, "body");

  if (!id || !name || !body) {
    throw new Error("Template, name, and body are required.");
  }

  await db.update(templates).set({
    type: templateTypeValue(formData.get("type")),
    name,
    trigger: textValue(formData, "trigger") || null,
    subject: textValue(formData, "subject") || null,
    body,
    status: textValue(formData, "status") || "active",
    updatedAt: new Date().toISOString(),
  }).where(eq(templates.id, id));

  await logActivity({
    action: "template.updated",
    metadata: { id, name },
  });

  revalidatePath("/templates");
  redirect("/templates");
}

export async function deleteTemplateAction(formData: FormData) {
  "use server";

  const id = textValue(formData, "templateId");
  if (!id) throw new Error("Template is required.");

  await db.delete(templates).where(eq(templates.id, id));

  await logActivity({
    action: "template.deleted",
    metadata: { id },
  });

  revalidatePath("/templates");
  redirect("/templates");
}
