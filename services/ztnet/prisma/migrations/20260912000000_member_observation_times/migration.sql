-- Historical lastSeen values were refresh timestamps, not online transitions.
-- Keep the new timestamps NULL until an actual observation is available.
ALTER TABLE "network_members"
  ADD COLUMN "lastOnlineAt" TIMESTAMP(3),
  ADD COLUMN "lastOfflineAt" TIMESTAMP(3),
  ADD COLUMN "statusObservedAt" TIMESTAMP(3),
  ADD COLUMN "observationControllerStartedAt" TIMESTAMP(3),
  ADD COLUMN "sourceLastOnlineAt" TIMESTAMP(3),
  ADD COLUMN "connectionStatus" INTEGER,
  ADD COLUMN "connectionPendingStatus" INTEGER,
  ADD COLUMN "connectionPendingSince" TIMESTAMP(3);

CREATE TABLE "NotificationTemplate" (
 "eventType" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "body" TEXT NOT NULL,
 "enabled" BOOLEAN NOT NULL DEFAULT true, "version" INTEGER NOT NULL DEFAULT 1,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "NotificationDelivery" (
 "id" TEXT PRIMARY KEY, "eventKey" TEXT NOT NULL, "eventType" TEXT NOT NULL,
 "title" TEXT NOT NULL, "body" TEXT NOT NULL, "templateVersion" INTEGER NOT NULL,
 "destinationFingerprint" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
 "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, "deliveredAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "NotificationDelivery_eventKey_key" ON "NotificationDelivery"("eventKey");
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt");

-- Existing sessions form the baseline; never replay historical login messages.
ALTER TABLE "Session" ADD COLUMN "notificationRecordedAt" TIMESTAMP(3);
UPDATE "Session" SET "notificationRecordedAt" = CURRENT_TIMESTAMP;

ALTER TABLE "network_members" ADD COLUMN "notifyOnFirstOnline" BOOLEAN NOT NULL DEFAULT true;
-- Avoid an upgrade storm, while still notifying the first online observation
-- of a genuinely new member created after this migration.
UPDATE "network_members" SET "notifyOnFirstOnline" = false;
