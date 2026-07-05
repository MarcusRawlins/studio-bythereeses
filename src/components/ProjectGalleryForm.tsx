import type { ProjectGallery } from "@/db/schema";
import { createProjectGalleryAction, deleteProjectGalleryAction, updateProjectGalleryAction } from "@/lib/gallery-actions";

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition placeholder:text-[#aaa197] focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,93,80,0.14)]";

const galleryStatuses = ["draft", "delivered", "archived"] as const;

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

/**
 * Create-or-edit gallery form. Modeled on ProjectEditForm.tsx: a plain
 * server-action-bound `<form>`, no client component needed. Pass `gallery`
 * to render the edit variant (pre-filled, PATCH-like update action);
 * omit it for the add-new variant.
 */
export function ProjectGalleryForm({ projectId, gallery }: { projectId: string; gallery?: ProjectGallery }) {
  const isEditing = Boolean(gallery);

  return (
    <form
      action={isEditing ? updateProjectGalleryAction : createProjectGalleryAction}
      className="grid gap-3 rounded-md border border-dashed border-[var(--line)] bg-[#fbfaf7] p-4 md:grid-cols-2"
    >
      <input type="hidden" name="projectId" value={projectId} />
      {gallery && <input type="hidden" name="galleryId" value={gallery.id} />}
      <label className="space-y-1.5 text-sm font-medium md:col-span-2">
        Gallery title
        <input name="title" required defaultValue={gallery?.title ?? ""} placeholder="Wedding gallery, Engagement gallery" className={inputClass} />
      </label>
      <label className="space-y-1.5 text-sm font-medium md:col-span-2">
        Delivery URL
        <input
          name="url"
          required
          type="url"
          defaultValue={gallery?.url ?? ""}
          placeholder="https://client.pixieset.com/..."
          className={inputClass}
        />
      </label>
      <label className="space-y-1.5 text-sm font-medium">
        Provider
        <input name="provider" defaultValue={gallery?.provider ?? ""} placeholder="Pixieset, Pic-Time, Cloudinary" className={inputClass} />
      </label>
      <label className="space-y-1.5 text-sm font-medium">
        Status
        <select name="status" defaultValue={gallery?.status ?? "draft"} className={inputClass}>
          {galleryStatuses.map((status) => (
            <option key={status} value={status}>
              {titleize(status)}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1.5 text-sm font-medium">
        Passcode (optional)
        <input name="passcode" defaultValue={gallery?.passcode ?? ""} placeholder="Provider gallery passcode" className={inputClass} />
      </label>
      <label className="space-y-1.5 text-sm font-medium">
        Available until (optional)
        <input name="expiresAt" type="date" defaultValue={gallery?.expiresAt?.slice(0, 10) ?? ""} className={inputClass} />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3 md:col-span-2">
        <button className="brand-primary-button rounded-sm px-4 py-2.5 text-sm transition">
          {isEditing ? "Save gallery" : "Add gallery"}
        </button>
        <p className="text-xs text-[var(--ink-muted)]">
          Only visible to the client once status is Delivered and the portal gallery section is enabled. Draft galleries stay admin/agent-only.
        </p>
      </div>
    </form>
  );
}

export function ProjectGalleryDeleteForm({ projectId, galleryId }: { projectId: string; galleryId: string }) {
  return (
    <form action={deleteProjectGalleryAction}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="galleryId" value={galleryId} />
      <button className="text-xs font-semibold text-[var(--danger)]">Delete</button>
    </form>
  );
}
