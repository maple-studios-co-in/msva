import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function stubProductionSmtp() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SMTP_HOST", "smtp.example.test");
  vi.stubEnv("SMTP_PORT", "587");
  vi.stubEnv("SMTP_TLS_MODE", "starttls");
  vi.stubEnv("SMTP_FROM", "console@example.test");
}

it("fails closed when the production SMTP configuration is incomplete", async () => {
  stubProductionSmtp();
  const { createSmtpLoginCodeDelivery, smtpSettingsFromEnv } = await import("./smtp.js");
  expect(smtpSettingsFromEnv()).toBeNull();
  expect(createSmtpLoginCodeDelivery()).toBeNull();
});

it("requires certificate-verified TLS without opportunistic fallback", async () => {
  stubProductionSmtp();
  vi.stubEnv("SMTP_USER", "console-user");
  vi.stubEnv("SMTP_PASSWORD", "not-a-real-password");
  const { smtpSettingsFromEnv } = await import("./smtp.js");
  expect(smtpSettingsFromEnv()).toMatchObject({
    connection: { host: "smtp.example.test", port: 587, secure: false, requireTLS: true, ignoreTLS: false, opportunisticTLS: false, logger: false, debug: false },
    from: "console@example.test",
    auth: { user: "console-user", pass: "not-a-real-password" },
    deadlineMs: 20_000
  });
  expect((smtpSettingsFromEnv()?.connection as { tls?: unknown }).tls).toBeUndefined();
  vi.stubEnv("SMTP_TLS_MODE", "implicit");
  expect(smtpSettingsFromEnv()?.connection).toMatchObject({ secure: true, requireTLS: false });
  vi.stubEnv("SMTP_TLS_MODE", "none");
  expect(smtpSettingsFromEnv()).toBeNull();
});

type FakeSmtp = { server: Server; port: number; commands: string[]; bodies: string[]; closed: () => boolean };

/** Plain-text SMTP peer on loopback. `stallRcptMs` delays the RCPT reply. */
async function fakeSmtp(stallRcptMs = 0): Promise<FakeSmtp> {
  const commands: string[] = [];
  const bodies: string[] = [];
  let socketClosed = false;
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    socket.on("close", () => { socketClosed = true; });
    socket.on("error", () => undefined);
    const reply = (line: string) => { if (!socket.destroyed && socket.writable) socket.write(`${line}\r\n`); };
    socket.write("220 fake.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end === -1) return;
        bodies.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 5);
        inData = false;
        reply("250 queued");
      }
      let index: number;
      while (!inData && (index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const verb = line.split(" ")[0]!.toUpperCase();
        commands.push(verb);
        if (verb === "EHLO") { reply("250-fake.test"); reply("250 SIZE 1000000"); }
        else if (verb === "MAIL") reply("250 sender ok");
        else if (verb === "RCPT") setTimeout(() => reply("250 recipient ok"), stallRcptMs);
        else if (verb === "DATA") { inData = true; reply("354 go ahead"); }
        else if (verb === "QUIT") { reply("221 bye"); socket.end(); }
        else reply("502 unsupported");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, commands, bodies, closed: () => socketClosed };
}

const plainLoopback = (port: number) => ({
  host: "127.0.0.1", port, secure: false, ignoreTLS: true, connectionTimeout: 2_000, greetingTimeout: 2_000, socketTimeout: 5_000, logger: false, debug: false
});

it("delivers one fixed text message and quits the connection", async () => {
  const smtp = await fakeSmtp();
  try {
    const { smtpLoginCodeDelivery } = await import("./smtp.js");
    const delivery = smtpLoginCodeDelivery({ connection: plainLoopback(smtp.port), from: "console@example.test", deadlineMs: 5_000 });
    await delivery.send({ recipient: "agent@example.test", code: "123456", expiresAt: new Date("2026-09-21T10:10:00.000Z") });
    await vi.waitFor(() => expect(smtp.commands).toContain("QUIT"));
    expect(smtp.commands).toEqual(["EHLO", "MAIL", "RCPT", "DATA", "QUIT"]);
    expect(smtp.bodies).toHaveLength(1);
    expect(smtp.bodies[0]).toMatch(/^Subject: Your MSVA sign-in code\r?$/m);
    expect(smtp.bodies[0]).toContain("Your sign-in code is 123456. It expires at 2026-09-21T10:10:00.000Z.");
  } finally {
    smtp.server.close();
  }
});

it("stops the exchange at the deadline so a late server reply cannot complete delivery", async () => {
  const smtp = await fakeSmtp(1_000);
  try {
    const { smtpLoginCodeDelivery } = await import("./smtp.js");
    const delivery = smtpLoginCodeDelivery({ connection: plainLoopback(smtp.port), from: "console@example.test", deadlineMs: 200 });
    const started = Date.now();
    await expect(delivery.send({ recipient: "agent@example.test", code: "654321", expiresAt: new Date() })).rejects.toThrow("SMTP delivery deadline exceeded");
    expect(Date.now() - started).toBeLessThan(900);
    await vi.waitFor(() => expect(smtp.closed()).toBe(true));
    // The stalled RCPT reply arrives after the deadline; the client must not
    // move on to DATA or transmit the code.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(smtp.commands).toEqual(["EHLO", "MAIL", "RCPT"]);
    expect(smtp.bodies).toHaveLength(0);
  } finally {
    smtp.server.close();
  }
});
