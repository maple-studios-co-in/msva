CREATE TYPE "AssessmentJobKind" AS ENUM ('POST_CALL');
CREATE TYPE "AssessmentJobState" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

CREATE TABLE "AssessmentJob" (
  "id" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "kind" "AssessmentJobKind" NOT NULL,
  "state" "AssessmentJobState" NOT NULL DEFAULT 'PENDING',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "claimedGeneration" INTEGER,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastInputHash" TEXT,
  "reason" TEXT,
  "source" TEXT NOT NULL DEFAULT 'AUTO_POST_CALL',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssessmentJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssessmentWorkerSlot" (
  "slot" INTEGER NOT NULL,
  "ownerToken" TEXT,
  "jobId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssessmentWorkerSlot_pkey" PRIMARY KEY ("slot")
);

CREATE TABLE "AssessmentReconciliationCursor" (
  "id" TEXT NOT NULL,
  "endedAt" TIMESTAMP(3),
  "callId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssessmentReconciliationCursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssessmentJob_callId_kind_key" ON "AssessmentJob"("callId", "kind");
CREATE INDEX "AssessmentJob_state_dueAt_idx" ON "AssessmentJob"("state", "dueAt");
CREATE INDEX "AssessmentJob_leaseExpiresAt_idx" ON "AssessmentJob"("leaseExpiresAt");
ALTER TABLE "AssessmentJob" ADD CONSTRAINT "AssessmentJob_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;
