import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// --------------------------------------------------------------------------
// Phase 15 (PWA) — manifest is a STATIC FILE, not a dynamic route.
//
// The manifest MUST ship as `public/manifest.webmanifest` (served straight from
// the Workers ASSETS binding, provably static + non-sensitive) and must NEVER be
// `app/manifest.ts` (a Route Handler on a public URL that could turn dynamic).
// --------------------------------------------------------------------------

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

// (a) The static manifest file exists at public/manifest.webmanifest.
const manifestPath = path.join(repoRoot, "public", "manifest.webmanifest");
assert.equal(
  fs.existsSync(manifestPath),
  true,
  "public/manifest.webmanifest must exist as a static file",
);

// (b) No app/manifest.* route handler exists (would make the manifest a dynamic
// route on a public URL — explicitly forbidden by the spec §2.1).
for (const candidate of [
  "src/app/manifest.ts",
  "src/app/manifest.js",
  "src/app/manifest.webmanifest.ts",
  "app/manifest.ts",
]) {
  assert.equal(
    fs.existsSync(path.join(repoRoot, candidate)),
    false,
    `${candidate} must NOT exist (manifest must be a static file, not a route)`,
  );
}

// (c) The manifest is valid JSON with the required install fields.
const raw = fs.readFileSync(manifestPath, "utf8");
let manifest: Record<string, unknown>;
assert.doesNotThrow(() => {
  manifest = JSON.parse(raw);
}, "manifest.webmanifest must be valid JSON");
manifest = JSON.parse(raw);

for (const field of [
  "id",
  "name",
  "short_name",
  "start_url",
  "scope",
  "display",
  "background_color",
  "theme_color",
  "icons",
]) {
  assert.ok(field in manifest, `manifest must define "${field}"`);
}

assert.equal(manifest.name, "The Reeses Studio", "manifest.name mirrors the app title");
assert.equal(manifest.start_url, "/", "manifest.start_url is bare / (dashboard)");
assert.equal(manifest.scope, "/", "manifest.scope is /");
assert.equal(manifest.id, "/", "manifest.id is a stable / identity");
assert.equal(manifest.display, "standalone", "manifest.display is standalone");
assert.equal(manifest.background_color, "#fbf8f2", "background_color = --bg cream");
assert.equal(manifest.theme_color, "#fbf8f2", "theme_color = --bg cream");
assert.ok(
  Array.isArray(manifest.icons) && (manifest.icons as unknown[]).length > 0,
  "manifest.icons must be a non-empty array",
);

// (d) Every referenced icon file actually exists on disk (src paths are absolute
// URLs -> resolve against public/, with /icon.png served from the App-Router
// metadata file src/app/icon.png).
const iconOnDisk = (src: string): boolean => {
  const clean = src.replace(/^\//, "");
  return (
    fs.existsSync(path.join(repoRoot, "public", clean)) ||
    fs.existsSync(path.join(repoRoot, "src", "app", clean))
  );
};
for (const icon of manifest.icons as Array<{ src: string }>) {
  assert.equal(iconOnDisk(icon.src), true, `manifest icon ${icon.src} must exist on disk`);
}

// (e) No service worker ships in v1 (manifest-only). public/sw.js must NOT exist
// yet — it is deferred behind PWA_SERVICE_WORKER. Its allowlist entry is added
// now so it 404s harmlessly (not login-walled) until the SW drop.
assert.equal(
  fs.existsSync(path.join(repoRoot, "public", "sw.js")),
  false,
  "public/sw.js must NOT exist in v1 (service worker is deferred)",
);

console.log("pwa manifest static-file + no-route + no-sw-in-v1 tests passed");
