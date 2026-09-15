-- Persist the live path detail needed for sortable connection/latency columns.
ALTER TABLE "network_members"
  ADD COLUMN "connectionType" TEXT,
  ADD COLUMN "latencyMs" INTEGER;

CREATE INDEX "network_members_nwid_connectionType_idx"
  ON "network_members"("nwid", "connectionType");

CREATE INDEX "network_members_nwid_latencyMs_idx"
  ON "network_members"("nwid", "latencyMs");
