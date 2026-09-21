-- Additive durable records for the unmounted demo-journey foundation.
-- Existing Call, Ticket, and TicketNote values are deliberately not rewritten.

CREATE TYPE "IdentityAssurance" AS ENUM ('UNVERIFIED', 'VERIFIED', 'DEMO_TRUSTED');
CREATE TYPE "JourneyKind" AS ENUM ('CONSUMER_COMPLAINT', 'RETAILER_ENQUIRY', 'DISTRIBUTOR_CASE', 'SALES_LEAD');
CREATE TYPE "CallerConfirmation" AS ENUM ('NEW', 'FOLLOW_UP', 'SEPARATE');
CREATE TYPE "BusinessRequestTruthState" AS ENUM ('RECORDED');
CREATE TYPE "RequestActionState" AS ENUM ('RECORDED', 'PENDING_STAFF');
CREATE TYPE "DemoLanguage" AS ENUM ('hi', 'en', 'hinglish');
CREATE TYPE "QueueAssignmentState" AS ENUM ('PENDING_STAFF');
CREATE TYPE "CallbackRequestState" AS ENUM ('REQUESTED', 'PENDING_STAFF', 'CANCELLED');
CREATE TYPE "TicketEvidenceState" AS ENUM ('NOT_REQUESTED', 'REQUESTED', 'RECEIVED', 'UNAVAILABLE');
CREATE TYPE "EvidenceAttachmentState" AS ENUM ('REQUESTED', 'RECEIVED', 'UNAVAILABLE');
CREATE TYPE "EvidenceProvenance" AS ENUM ('STORED', 'FIXTURE');
CREATE TYPE "HandoffState" AS ENUM ('REQUESTED', 'ASSIGNED', 'JOINING', 'HUMAN_ACTIVE', 'FAILED', 'TIMED_OUT');
CREATE TYPE "RiskSentiment" AS ENUM ('NEUTRAL', 'POSITIVE', 'NEGATIVE', 'UNKNOWN');
CREATE TYPE "RiskUrgency" AS ENUM ('ROUTINE', 'POSSIBLE_SAFETY', 'UNKNOWN');
CREATE TYPE "RiskMode" AS ENUM ('SHADOW');
CREATE TYPE "RiskSource" AS ENUM ('FIXTURE', 'DETECTOR');
CREATE TYPE "RiskAlertState" AS ENUM ('PENDING_STAFF', 'ACKNOWLEDGED', 'CLOSED');

ALTER TABLE "Ticket"
  ADD COLUMN "evidenceState" "TicketEvidenceState" NOT NULL DEFAULT 'NOT_REQUESTED',
  ADD COLUMN "evidenceRequestedAt" TIMESTAMP(3);

CREATE TABLE "DemoCallIdentity" (
  "callId" TEXT NOT NULL,
  "callerId" TEXT,
  "assurance" "IdentityAssurance" NOT NULL DEFAULT 'UNVERIFIED',
  "verifiedAt" TIMESTAMP(3),
  "verificationRef" TEXT,
  "fixtureKey" TEXT,
  CONSTRAINT "DemoCallIdentity_pkey" PRIMARY KEY ("callId"),
  CONSTRAINT "DemoCallIdentity_attestation_check" CHECK (
    ("assurance" = 'UNVERIFIED' AND "verifiedAt" IS NULL AND "verificationRef" IS NULL AND "fixtureKey" IS NULL)
    OR ("assurance" = 'VERIFIED' AND "callerId" IS NOT NULL AND "verifiedAt" IS NOT NULL AND "verificationRef" IS NOT NULL AND "fixtureKey" IS NULL)
    OR ("assurance" = 'DEMO_TRUSTED' AND "callerId" IS NOT NULL AND "verifiedAt" IS NOT NULL AND "verificationRef" IS NULL AND "fixtureKey" IS NOT NULL)
  )
);

CREATE TABLE "BusinessRequest" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "callerId" TEXT,
  "ticketId" TEXT NOT NULL,
  "journey" "JourneyKind" NOT NULL,
  "callerConfirmation" "CallerConfirmation" NOT NULL,
  "parentRequestId" TEXT,
  "language" "DemoLanguage" NOT NULL,
  "territory" TEXT NOT NULL,
  "verificationState" "IdentityAssurance" NOT NULL DEFAULT 'UNVERIFIED',
  "truthState" "BusinessRequestTruthState" NOT NULL DEFAULT 'RECORDED',
  "actionState" "RequestActionState" NOT NULL DEFAULT 'PENDING_STAFF',
  "fields" JSONB NOT NULL,
  "payloadCanonical" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BusinessRequest_follow_up_parent_check" CHECK (("callerConfirmation" = 'FOLLOW_UP') = ("parentRequestId" IS NOT NULL)),
  CONSTRAINT "BusinessRequest_not_own_parent_check" CHECK ("parentRequestId" IS NULL OR "parentRequestId" <> "id"),
  CONSTRAINT "BusinessRequest_payload_hash_check" CHECK ("payloadHash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "QueueAssignment" (
  "id" TEXT NOT NULL,
  "businessRequestId" TEXT NOT NULL,
  "territory" TEXT NOT NULL,
  "language" "DemoLanguage" NOT NULL,
  "queueKey" TEXT NOT NULL DEFAULT 'support',
  "state" "QueueAssignmentState" NOT NULL DEFAULT 'PENDING_STAFF',
  "assignedUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QueueAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallbackRequest" (
  "id" TEXT NOT NULL,
  "businessRequestId" TEXT NOT NULL,
  "state" "CallbackRequestState" NOT NULL DEFAULT 'PENDING_STAFF',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "preferredWindow" TEXT,
  CONSTRAINT "CallbackRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EvidenceAttachment" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "state" "EvidenceAttachmentState" NOT NULL,
  "provenance" "EvidenceProvenance" NOT NULL,
  "storageKey" TEXT,
  "fixtureRef" TEXT,
  "receivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidenceAttachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EvidenceAttachment_received_check" CHECK (
    "state" <> 'RECEIVED' OR ("provenance" = 'STORED' AND "storageKey" IS NOT NULL AND length("storageKey") > 0 AND "receivedAt" IS NOT NULL)
  ),
  CONSTRAINT "EvidenceAttachment_fixture_check" CHECK (
    "provenance" <> 'FIXTURE' OR ("state" <> 'RECEIVED' AND "storageKey" IS NULL AND "receivedAt" IS NULL AND "fixtureRef" IS NOT NULL AND length("fixtureRef") > 0)
  ),
  CONSTRAINT "EvidenceAttachment_stored_check" CHECK ("provenance" <> 'STORED' OR "fixtureRef" IS NULL)
);

CREATE TABLE "Handoff" (
  "id" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "state" "HandoffState" NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "assignedUserId" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  CONSTRAINT "Handoff_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Handoff_version_check" CHECK ("version" >= 1),
  CONSTRAINT "Handoff_active_owner_check" CHECK (
    "state" NOT IN ('ASSIGNED', 'JOINING', 'HUMAN_ACTIVE') OR "assignedUserId" IS NOT NULL
  ),
  CONSTRAINT "Handoff_human_active_check" CHECK ("state" <> 'HUMAN_ACTIVE' OR "activatedAt" IS NOT NULL)
);

CREATE TABLE "RiskAssessment" (
  "id" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "sentiment" "RiskSentiment" NOT NULL,
  "urgency" "RiskUrgency" NOT NULL,
  "mode" "RiskMode" NOT NULL DEFAULT 'SHADOW',
  "source" "RiskSource" NOT NULL,
  "rationale" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiskAssessment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RiskAlert" (
  "id" TEXT NOT NULL,
  "riskAssessmentId" TEXT NOT NULL,
  "state" "RiskAlertState" NOT NULL DEFAULT 'PENDING_STAFF',
  "ownerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiskAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessRequest_requestId_key" ON "BusinessRequest"("requestId");
CREATE INDEX "BusinessRequest_callId_idx" ON "BusinessRequest"("callId");
CREATE INDEX "BusinessRequest_callerId_createdAt_idx" ON "BusinessRequest"("callerId", "createdAt");
CREATE INDEX "BusinessRequest_ticketId_idx" ON "BusinessRequest"("ticketId");
CREATE INDEX "BusinessRequest_parentRequestId_idx" ON "BusinessRequest"("parentRequestId");
CREATE UNIQUE INDEX "QueueAssignment_businessRequestId_key" ON "QueueAssignment"("businessRequestId");
CREATE UNIQUE INDEX "CallbackRequest_businessRequestId_key" ON "CallbackRequest"("businessRequestId");
CREATE INDEX "EvidenceAttachment_ticketId_idx" ON "EvidenceAttachment"("ticketId");
CREATE INDEX "Handoff_callId_idx" ON "Handoff"("callId");
CREATE UNIQUE INDEX "Handoff_one_active_per_call" ON "Handoff"("callId") WHERE "state" IN ('REQUESTED', 'ASSIGNED', 'JOINING', 'HUMAN_ACTIVE');
CREATE INDEX "RiskAssessment_callId_idx" ON "RiskAssessment"("callId");
CREATE UNIQUE INDEX "RiskAlert_riskAssessmentId_key" ON "RiskAlert"("riskAssessmentId");

ALTER TABLE "DemoCallIdentity" ADD CONSTRAINT "DemoCallIdentity_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DemoCallIdentity" ADD CONSTRAINT "DemoCallIdentity_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "Caller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BusinessRequest" ADD CONSTRAINT "BusinessRequest_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BusinessRequest" ADD CONSTRAINT "BusinessRequest_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "Caller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BusinessRequest" ADD CONSTRAINT "BusinessRequest_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BusinessRequest" ADD CONSTRAINT "BusinessRequest_parentRequestId_fkey" FOREIGN KEY ("parentRequestId") REFERENCES "BusinessRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QueueAssignment" ADD CONSTRAINT "QueueAssignment_businessRequestId_fkey" FOREIGN KEY ("businessRequestId") REFERENCES "BusinessRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QueueAssignment" ADD CONSTRAINT "QueueAssignment_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CallbackRequest" ADD CONSTRAINT "CallbackRequest_businessRequestId_fkey" FOREIGN KEY ("businessRequestId") REFERENCES "BusinessRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvidenceAttachment" ADD CONSTRAINT "EvidenceAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiskAlert" ADD CONSTRAINT "RiskAlert_riskAssessmentId_fkey" FOREIGN KEY ("riskAssessmentId") REFERENCES "RiskAssessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiskAlert" ADD CONSTRAINT "RiskAlert_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
