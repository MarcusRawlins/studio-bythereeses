function normalizedNote(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() || "";
}

export function isSystemImportProjectNote(value: string | null | undefined) {
  const note = normalizedNote(value);
  if (!note) return false;

  return /^Imported from HoneyBook on \d{4}-\d{2}-\d{2}\. HoneyBook project:/i.test(note);
}

export function projectWorkingNotes(value: string | null | undefined) {
  const note = value?.trim() || null;
  if (!note || isSystemImportProjectNote(note)) return null;
  return note;
}
