ALTER TABLE notification_outbox
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

UPDATE notification_outbox
SET claimed_at = created_at
WHERE status = 'publishing'
    AND claimed_at IS NULL;

CREATE INDEX IF NOT EXISTS notification_outbox_publishing_claimed_at_idx
    ON notification_outbox (claimed_at)
    WHERE status = 'publishing';
