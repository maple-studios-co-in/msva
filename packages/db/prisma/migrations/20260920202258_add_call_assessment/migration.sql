-- CreateEnum
CREATE TYPE "CallAssessmentStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "CallAssessment" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "requestedModel" TEXT NOT NULL,
    "returnedModel" TEXT,
    "rubricVersion" TEXT NOT NULL,
    "preprocessingVersion" TEXT NOT NULL,
    "status" "CallAssessmentStatus" NOT NULL,
    "requestedById" TEXT,
    "attemptToken" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "leaseExpiresAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "result" JSONB,
    "inputCharCount" INTEGER NOT NULL,
    "utteranceCount" INTEGER NOT NULL,
    "linkedTicketRecorded" BOOLEAN NOT NULL DEFAULT false,
    "inputLanguage" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallAssessment_callId_requestedAt_idx" ON "CallAssessment"("callId", "requestedAt");

-- CreateIndex
CREATE INDEX "CallAssessment_status_leaseExpiresAt_idx" ON "CallAssessment"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallAssessment_callId_inputHash_requestedModel_rubricVersio_key" ON "CallAssessment"("callId", "inputHash", "requestedModel", "rubricVersion");

-- AddForeignKey
ALTER TABLE "CallAssessment" ADD CONSTRAINT "CallAssessment_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallAssessment" ADD CONSTRAINT "CallAssessment_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
