CREATE TYPE "LoginCodeDeliveryState" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

ALTER TABLE "LoginCode"
  ADD COLUMN "deliveryState" "LoginCodeDeliveryState" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3);

CREATE TABLE "AuthRateBucket" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "scope" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthRateBucket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthRateBucket_scope_keyHash_windowStart_key" ON "AuthRateBucket"("scope", "keyHash", "windowStart");
CREATE INDEX "AuthRateBucket_expiresAt_idx" ON "AuthRateBucket"("expiresAt");
CREATE INDEX "LoginCode_userId_deliveryState_expiresAt_idx" ON "LoginCode"("userId", "deliveryState", "expiresAt");
ALTER TABLE "AuthRateBucket" ADD CONSTRAINT "AuthRateBucket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
