import assert from "node:assert/strict";
import { isSystemImportProjectNote, projectWorkingNotes } from "./project-notes";

const honeyBookImportNote = `
  Imported from HoneyBook on 2026-05-12. HoneyBook project: Galit & Ari.
  Lead date: 2025-03-11. Booked: 2025-03-13. Source: Instagram.
`;

assert.equal(isSystemImportProjectNote(honeyBookImportNote), true);
assert.equal(projectWorkingNotes(honeyBookImportNote), null);

assert.equal(isSystemImportProjectNote("Planner prefers family formals before ceremony."), false);
assert.equal(projectWorkingNotes("  Planner prefers family formals before ceremony.  "), "Planner prefers family formals before ceremony.");
assert.equal(projectWorkingNotes("   "), null);

console.log("project notes tests passed");
