UPDATE clients
SET email = lower(trim(email))
WHERE email <> lower(trim(email));

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_email_normalized_unique
  ON clients(lower(trim(email)));
