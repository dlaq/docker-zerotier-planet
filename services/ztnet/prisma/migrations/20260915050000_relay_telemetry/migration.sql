CREATE TABLE "RelayObserver" (
  "id" TEXT NOT NULL,
  "observerId" TEXT NOT NULL,
  "bootId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "confidence" TEXT NOT NULL DEFAULT 'wire_observed',
  "lastSeen" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RelayObserver_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RelayObserver_observerId_bootId_key"
  ON "RelayObserver"("observerId", "bootId");
CREATE INDEX "RelayObserver_observerId_lastSeen_idx"
  ON "RelayObserver"("observerId", "lastSeen");

CREATE TABLE "RelayFlowObservation" (
  "id" TEXT NOT NULL,
  "observerId" TEXT NOT NULL,
  "bootId" TEXT NOT NULL,
  "sessionKey" TEXT NOT NULL DEFAULT '',
  "sourceNodeId" TEXT NOT NULL,
  "destinationNodeId" TEXT NOT NULL,
  "transport" TEXT NOT NULL,
  "firstSeen" TIMESTAMP(3) NOT NULL,
  "lastSeen" TIMESTAMP(3) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "packets" BIGINT NOT NULL DEFAULT 0,
  "bytes" BIGINT NOT NULL DEFAULT 0,
  "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RelayFlowObservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RelayFlowObservation_observerId_bootId_sessionKey_sourceNodeId_destinationNodeId_transport_key"
  ON "RelayFlowObservation"("observerId", "bootId", "sessionKey", "sourceNodeId", "destinationNodeId", "transport");
CREATE INDEX "RelayFlowObservation_sourceNodeId_lastSeen_idx"
  ON "RelayFlowObservation"("sourceNodeId", "lastSeen");
CREATE INDEX "RelayFlowObservation_destinationNodeId_lastSeen_idx"
  ON "RelayFlowObservation"("destinationNodeId", "lastSeen");
CREATE INDEX "RelayFlowObservation_observerId_active_lastSeen_idx"
  ON "RelayFlowObservation"("observerId", "active", "lastSeen");

CREATE TABLE "RelaySessionObservation" (
  "id" TEXT NOT NULL,
  "observerId" TEXT NOT NULL,
  "bootId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "remoteAddress" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "lastSeen" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT false,
  "packetsToUdp" BIGINT NOT NULL DEFAULT 0,
  "packetsToTcp" BIGINT NOT NULL DEFAULT 0,
  "bytesToUdp" BIGINT NOT NULL DEFAULT 0,
  "bytesToTcp" BIGINT NOT NULL DEFAULT 0,
  "flowCount" INTEGER NOT NULL DEFAULT 0,
  "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RelaySessionObservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RelaySessionObservation_observerId_bootId_sessionId_key"
  ON "RelaySessionObservation"("observerId", "bootId", "sessionId");
CREATE INDEX "RelaySessionObservation_observerId_active_lastSeen_idx"
  ON "RelaySessionObservation"("observerId", "active", "lastSeen");
CREATE INDEX "RelaySessionObservation_remoteAddress_lastSeen_idx"
  ON "RelaySessionObservation"("remoteAddress", "lastSeen");

CREATE TABLE "RelayTrafficBucket" (
  "id" TEXT NOT NULL,
  "observerId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "transport" TEXT NOT NULL,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "bytesIn" BIGINT NOT NULL DEFAULT 0,
  "bytesOut" BIGINT NOT NULL DEFAULT 0,
  "packetsIn" BIGINT NOT NULL DEFAULT 0,
  "packetsOut" BIGINT NOT NULL DEFAULT 0,
  "sessionsStarted" INTEGER NOT NULL DEFAULT 0,
  "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RelayTrafficBucket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RelayTrafficBucket_observerId_nodeId_transport_bucketStart_key"
  ON "RelayTrafficBucket"("observerId", "nodeId", "transport", "bucketStart");
CREATE INDEX "RelayTrafficBucket_nodeId_bucketStart_idx"
  ON "RelayTrafficBucket"("nodeId", "bucketStart");
CREATE INDEX "RelayTrafficBucket_observerId_bucketStart_idx"
  ON "RelayTrafficBucket"("observerId", "bucketStart");
