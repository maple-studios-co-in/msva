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
    connection: { host: "smtp.example.test", port: 587, secure: false, requireTLS: true, ignoreTLS: false, opportunisticTLS: false, logger: false, debug: false, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" } },
    from: { name: "", address: "console@example.test" },
    auth: { user: "console-user", pass: "not-a-real-password" },
    deadlineMs: 20_000
  });
  vi.stubEnv("SMTP_TLS_MODE", "implicit");
  expect(smtpSettingsFromEnv()?.connection).toMatchObject({ secure: true, requireTLS: false });
  vi.stubEnv("SMTP_TLS_MODE", "none");
  expect(smtpSettingsFromEnv()).toBeNull();
});

it("accepts one sender with a display name and rejects anything else", async () => {
  stubProductionSmtp();
  vi.stubEnv("SMTP_USER", "console-user");
  vi.stubEnv("SMTP_PASSWORD", "not-a-real-password");
  const { smtpSettingsFromEnv } = await import("./smtp.js");
  vi.stubEnv("SMTP_FROM", "MSVA Console <console@example.test>");
  expect(smtpSettingsFromEnv()).toMatchObject({ from: { name: "MSVA Console", address: "console@example.test" } });
  for (const invalid of ["a@example.test, b@example.test", "MSVA Console", "Team: a@example.test, b@example.test;", "Team: a@example.test;", ""]) {
    vi.stubEnv("SMTP_FROM", invalid);
    expect(smtpSettingsFromEnv()).toBeNull();
  }
});

type FakeSmtp = { server: Server; port: number; commands: string[]; lines: string[]; bodies: string[]; closed: () => boolean; lateReplyFailed: () => boolean };

/**
 * Plain-text SMTP peer on loopback. `stallRcptMs` delays the RCPT reply;
 * `ignoreClose` keeps the server's side open after the client half-closes, and
 * after it answers QUIT.
 */
async function fakeSmtp(stallRcptMs = 0, ignoreClose = false): Promise<FakeSmtp> {
  const commands: string[] = [];
  const lines: string[] = [];
  const bodies: string[] = [];
  let socketClosed = false;
  let lateReplyFailed = false;
  // ignoreClose keeps the server's side open after the client half-closes.
  const server = createServer({ allowHalfOpen: ignoreClose }, (socket: Socket) => {
    let buffer = "";
    let inData = false;
    socket.on("close", () => { socketClosed = true; });
    socket.on("error", () => { lateReplyFailed = true; });
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
        lines.push(line);
        if (verb === "EHLO") { reply("250-fake.test"); reply("250 SIZE 1000000"); }
        else if (verb === "MAIL") reply("250 sender ok");
        else if (verb === "RCPT") setTimeout(() => {
          reply("250 recipient ok");
          // A reset from a released client only surfaces on a later write.
          if (ignoreClose) setTimeout(() => reply("250 still waiting"), 150);
        }, stallRcptMs);
        else if (verb === "DATA") { inData = true; reply("354 go ahead"); }
        else if (verb === "QUIT") {
          reply("221 bye");
          if (!ignoreClose) socket.end();
          else {
            // Keeps writing: once the client releases its socket, a write fails.
            const talk = setInterval(() => reply("250 still here"), 500);
            talk.unref();
            socket.on("close", () => clearInterval(talk));
            socket.on("error", () => clearInterval(talk));
          }
        }
        else reply("502 unsupported");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, commands, lines, bodies, closed: () => socketClosed, lateReplyFailed: () => lateReplyFailed };
}

const plainLoopback = (port: number) => ({
  host: "127.0.0.1", port, secure: false, ignoreTLS: true, connectionTimeout: 2_000, greetingTimeout: 2_000, socketTimeout: 5_000, logger: false, debug: false
});

it("delivers one fixed text message and quits the connection", async () => {
  const smtp = await fakeSmtp();
  try {
    const { smtpLoginCodeDelivery } = await import("./smtp.js");
    const delivery = smtpLoginCodeDelivery({ connection: plainLoopback(smtp.port), from: { name: "MSVA Console", address: "console@example.test" }, deadlineMs: 5_000 });
    await delivery.send({ recipient: "agent@example.test", code: "123456", expiresAt: new Date("2026-09-21T10:10:00.000Z") });
    await vi.waitFor(() => expect(smtp.commands).toContain("QUIT"));
    expect(smtp.commands).toEqual(["EHLO", "MAIL", "RCPT", "DATA", "QUIT"]);
    expect(smtp.lines).toContain("MAIL FROM:<console@example.test>");
    expect(smtp.bodies[0]).toMatch(/^From: MSVA Console <console@example\.test>\r?$/m);
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
    const delivery = smtpLoginCodeDelivery({ connection: plainLoopback(smtp.port), from: { name: "", address: "console@example.test" }, deadlineMs: 200 });
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

it("releases the socket at the deadline even when the server ignores the close", async () => {
  const smtp = await fakeSmtp(1_000, true);
  try {
    const { smtpLoginCodeDelivery } = await import("./smtp.js");
    const delivery = smtpLoginCodeDelivery({ connection: plainLoopback(smtp.port), from: { name: "", address: "console@example.test" }, deadlineMs: 200 });
    await expect(delivery.send({ recipient: "agent@example.test", code: "111111", expiresAt: new Date() })).rejects.toThrow("SMTP delivery deadline exceeded");
    // The stalled server finally replies; a destroyed client socket answers with a reset.
    await vi.waitFor(() => expect(smtp.lateReplyFailed() || smtp.closed()).toBe(true), { timeout: 3_000 });
    expect(smtp.commands).toEqual(["EHLO", "MAIL", "RCPT"]);
  } finally {
    smtp.server.close();
  }
});

it("releases the socket after a delivery even when the server never closes it", { timeout: 10_000 }, async () => {
  const smtp = await fakeSmtp(0, true);
  try {
    const { smtpLoginCodeDelivery } = await import("./smtp.js");
    const delivery = smtpLoginCodeDelivery({ connection: plainLoopback(smtp.port), from: { name: "", address: "console@example.test" }, deadlineMs: 5_000 });
    await delivery.send({ recipient: "agent@example.test", code: "222222", expiresAt: new Date() });
    await vi.waitFor(() => expect(smtp.commands).toContain("QUIT"));
    await vi.waitFor(() => expect(smtp.lateReplyFailed() || smtp.closed()).toBe(true), { timeout: 5_000 });
    expect(smtp.bodies).toHaveLength(1);
  } finally {
    smtp.server.close();
  }
});
