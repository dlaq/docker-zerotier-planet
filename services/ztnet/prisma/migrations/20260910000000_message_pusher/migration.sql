-- Add the optional Message Pusher notification channel.  Secrets remain
-- encrypted by the application; this migration only creates nullable fields.
ALTER TABLE "GlobalOptions"
  ADD COLUMN "messagePusherEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "messagePusherUrl" TEXT,
  ADD COLUMN "messagePusherUsername" TEXT,
  ADD COLUMN "messagePusherToken" TEXT,
  ADD COLUMN "messagePusherChannel" TEXT;
