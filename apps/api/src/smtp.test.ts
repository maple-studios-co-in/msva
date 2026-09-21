import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("fails closed when the production SMTP configuration is incomplete", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SMTP_HOST", "smtp.example.test");
  vi.stubEnv("SMTP_PORT", "587");
  vi.stubEnv("SMTP_TLS_MODE", "starttls");
  vi.stubEnv("SMTP_FROM", "console@example.test");
  const { createSmtpLoginCodeDelivery } = await import("./smtp.js");
  expect(createSmtpLoginCodeDelivery()).toBeNull();
});

it("uses required TLS and disables file and URL access for configured SMTP", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SMTP_HOST", "smtp.example.test");
  vi.stubEnv("SMTP_PORT", "587");
  vi.stubEnv("SMTP_TLS_MODE", "starttls");
  vi.stubEnv("SMTP_FROM", "console@example.test");
  vi.stubEnv("SMTP_USER", "console-user");
  vi.stubEnv("SMTP_PASSWORD", "not-a-real-password");
  const createTransport = vi.fn(() => ({ sendMail: vi.fn() }));
  vi.doMock("nodemailer", () => ({ default: { createTransport } }));
  const { createSmtpLoginCodeDelivery } = await import("./smtp.js");
  expect(createSmtpLoginCodeDelivery()).not.toBeNull();
  expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
    host: "smtp.example.test", port: 587, secure: false, requireTLS: true,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false
  }));
});
