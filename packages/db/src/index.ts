import { PrismaClient } from "@prisma/client";

// One PrismaClient per process. Services import `prisma` from here so the
// connection pool is shared across routes, tools and background jobs.
//
// `DATABASE_URL` is read from the environment by the generated client; each
// service loads its own `.env` before importing this module (see the `env.ts`
// pattern in apps/api and apps/telephony).

declare global {
  // eslint-disable-next-line no-var
  var __msvaPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__msvaPrisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === "query" ? ["query", "warn", "error"] : ["warn", "error"]
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__msvaPrisma = prisma;
}

/** True when a database is configured and reachable. Cheap enough to call per request. */
export async function databaseReady(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export * from "@prisma/client";
