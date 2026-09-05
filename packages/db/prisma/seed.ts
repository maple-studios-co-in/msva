import { PrismaClient, UserRole } from "@prisma/client";

// Seed the minimum a fresh environment needs: the default voice agent and a
// first admin. Idempotent — safe to run on every deploy.
//
//   ADMIN_EMAIL=you@maplestudios.co.in ADMIN_NAME="Aditya" pnpm --filter @msva/db seed

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.agent.upsert({
    where: { slug: "madhusudan-support" },
    update: {},
    create: {
      slug: "madhusudan-support",
      name: "Madhusudan Support",
      channel: "voice",
      promptVersion: "v1",
      voice: process.env.TTS_VOICE ?? "neha",
      language: "hi-IN"
    }
  });

  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (adminEmail) {
    await prisma.user.upsert({
      where: { email: adminEmail },
      update: { role: UserRole.ADMIN, active: true },
      create: {
        email: adminEmail,
        name: process.env.ADMIN_NAME ?? "Admin",
        role: UserRole.ADMIN
      }
    });
    console.log(`[seed] admin user ready: ${adminEmail}`);
  } else {
    console.log("[seed] ADMIN_EMAIL not set — no admin user created");
  }
  console.log("[seed] default agent ready: madhusudan-support");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
