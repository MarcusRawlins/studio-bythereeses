import assert from "node:assert/strict";
import { projectEventCalendarStatusAfterEdit } from "./project-event-calendar";

assert.equal(
  projectEventCalendarStatusAfterEdit({
    eventDate: null,
    googleCalendarEventId: null,
  }),
  "not_connected",
  "events without dates should not be calendar-syncable",
);

assert.equal(
  projectEventCalendarStatusAfterEdit({
    eventDate: "2026-08-30",
    googleCalendarEventId: null,
  }),
  "needs_google_connection",
  "dated events without Google event ids should be ready to sync",
);

assert.equal(
  projectEventCalendarStatusAfterEdit({
    eventDate: "2026-08-30",
    googleCalendarEventId: "google-event-id",
  }),
  "synced",
  "dated events with Google event ids should remain marked as synced after a successful update",
);

console.log("project event calendar tests passed");
