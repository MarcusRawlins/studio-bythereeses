export function projectEventCalendarStatusAfterEdit({
  eventDate,
  googleCalendarEventId,
}: {
  eventDate: string | null;
  googleCalendarEventId: string | null;
}) {
  if (!eventDate) return "not_connected";
  if (googleCalendarEventId) return "synced";
  return "needs_google_connection";
}
