CREATE TABLE IF NOT EXISTS shooting_locations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  region TEXT,
  city TEXT,
  state TEXT,
  country TEXT NOT NULL DEFAULT 'USA',
  address TEXT,
  google_maps_url TEXT,
  location_type TEXT NOT NULL DEFAULT 'other',
  best_for TEXT,
  permit_notes TEXT,
  access_notes TEXT,
  light_notes TEXT,
  drone_notes TEXT,
  general_notes TEXT,
  tags_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shooting_locations_region ON shooting_locations(region, city, state);
CREATE INDEX IF NOT EXISTS idx_shooting_locations_status ON shooting_locations(status);
CREATE INDEX IF NOT EXISTS idx_shooting_locations_type ON shooting_locations(location_type);

INSERT OR IGNORE INTO shooting_locations (
  id, name, region, city, state, country, location_type, best_for,
  permit_notes, access_notes, light_notes, drone_notes, general_notes,
  tags_json, status, created_at, updated_at
) VALUES (
  'shooting-location-rock-harbor-beach-orleans-ma',
  'Rock Harbor Beach',
  'Cape Cod',
  'Orleans',
  'MA',
  'USA',
  'beach',
  'Cape Cod engagement sessions, coastal portraits, sunset portraits, drone scouting, wide environmental images',
  'Confirm current town, beach, parking, drone, and commercial photography rules before using for paid work.',
  'Scout parking, tide timing, beach access, wind, crowds, and seasonal restrictions before scheduling.',
  'Strong candidate for sunset and golden-hour work; verify exact sun angle seasonally.',
  'Useful for harbor/coastal context if permitted and wind is manageable. Avoid guests, boats, wildlife, roads, and crowded beach areas.',
  'Added as a liked Cape Cod shooting location. Needs Tyler field notes and sample image references after the next scout/session.',
  '["cape cod","orleans","beach","harbor","sunset","drone","engagements"]',
  'active',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
