CREATE INDEX IF NOT EXISTS notification_outbox_pending_id_idx
    ON notification_outbox (id)
    WHERE status = 'pending';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'notifications'::regclass
          AND conname = 'notifications_status_check'
    ) THEN
        ALTER TABLE notifications
            ADD CONSTRAINT notifications_status_check
            CHECK (status IN ('pending', 'processing', 'sent', 'failed'));
    END IF;
END $$;
