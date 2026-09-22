ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
