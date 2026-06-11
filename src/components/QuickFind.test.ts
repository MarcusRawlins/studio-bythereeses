import assert from "node:assert/strict";
import { formatProjectMeta } from "./QuickFind";

function main() {
  assert.equal(formatProjectMeta({
    id: "project-orphan",
    name: "Needs Primary Client Wedding",
    type: "wedding",
    stage: "inquiry",
    status: "active",
    eventDate: "2026-11-11",
    venueName: "The Repair Room",
    location: "Beacon, NY",
    primaryClient: null,
    openBalanceCents: 0,
  }), "Needs primary client · 2026-11-11 · The Repair Room");

  assert.equal(formatProjectMeta({
    id: "project-linked",
    name: "Alex Wedding",
    type: "wedding",
    stage: "planning",
    status: "active",
    eventDate: "2026-09-19",
    venueName: null,
    location: "Hudson, NY",
    primaryClient: {
      name: "Alex Taylor",
      email: "alex@example.com",
    },
    openBalanceCents: 0,
  }), "Alex Taylor · 2026-09-19 · Hudson, NY");

  console.log("quick find tests passed");
}

main();
