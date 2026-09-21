import { afterEach, expect, it, vi } from "vitest";

const { findUnique, auditCreate, statements, rows } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  auditCreate: vi.fn(async () => undefined),
  // Statements a verification runs, by shape, and the rows its reads return.
  statements: [] as string[],
  rows: { user: null as { id: string } | null, currentUser: null as object | null, candidate: null as object | null }
}));
vi.mock("@msva/db", () => {
  const tx = {
    $queryRaw: async (sql: TemplateStringsArray) => {
      statements.push(sql.join("?"));
      return sql.join("").includes('INSERT INTO "AuthRateBucket"') ? [{ id: "reserved" }] : [];
    },
    user: {
      findFirst: async () => { statements.push("user.findFirst"); return rows.user; },
      findUnique: async () => { statements.push("user.findUnique"); return rows.currentUser; }
    },
    loginCode: {
      findFirst: async () => { statements.push("loginCode.findFirst"); return rows.candidate; },
      updateMany: async () => { statements.push("loginCode.updateMany"); return { count: 0 }; }
    }
  };
  return {
    prisma: {
      session: { findUnique, update: vi.fn(async () => undefined) },
      auditLog: { create: auditCreate },
      $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
      $executeRaw: async (sql: TemplateStringsArray) => { statements.push(sql.join("?")); return 0; },
      authRateBucket: { findMany: async () => [] }
    }
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  findUnique.mockReset();
  auditCreate.mockClear();
});

function request(headers: Record<string, string | undefined>) {
  return { headers } as any;
}

function proxied(peer: string, forwarded?: string) {
  return { socket: { remoteAddress: peer }, get: (name: string) => (name.toLowerCase() === "x-forwarded-for" ? forwarded : undefined) } as any;
}

it("rejects malformed, duplicate, and ambiguous session credentials safely", async () => {
  const { tokenFromRequest } = await import("./auth.js");
  expect(tokenFromRequest(request({ cookie: "msva_session=%E0%A4%A" }))).toBeNull();
  expect(tokenFromRequest(request({ cookie: "msva_session=a; msva_session=b" }))).toBeNull();
  expect(tokenFromRequest(request({ cookie: "msva_session=a", authorization: "Bearer b" }))).toBeNull();
});

it("ignores other cookies, even duplicated or malformed ones", async () => {
  const { tokenFromRequest } = await import("./auth.js");
  const token = "a".repeat(64);
  expect(tokenFromRequest(request({ cookie: `tracker=50%; _ga=1; _ga=2; msva_session=${token}` }))).toBe(token);
  expect(tokenFromRequest(request({ cookie: "tracker=50%; _ga=1" }))).toBeNull();
});

it("treats a session as expired at its expiry instant", async () => {
  const { authenticate } = await import("./auth.js");
  const expiresAt = new Date("2026-09-21T10:00:00.000Z");
  vi.useFakeTimers();
  vi.setSystemTime(expiresAt);
  findUnique.mockResolvedValue({ id: "session-1", expiresAt, lastSeenAt: expiresAt, user: { id: "user-1", email: "a@example.test", name: "A", role: "AGENT", active: true } });
  const req = request({ cookie: `msva_session=${"a".repeat(64)}` });
  const next = vi.fn();
  await authenticate(req, {} as any, next);
  expect(next).toHaveBeenCalledOnce();
  expect(req.user).toBeUndefined();
});

it("takes the first untrusted hop from a trusted proxy, not a client-supplied prefix", async () => {
  vi.stubEnv("TRUSTED_PROXY_ADDRESSES", "127.0.0.1, 10.0.0.0/8");
  const { trustedNetworkFromRequest } = await import("./auth.js");
  expect(trustedNetworkFromRequest(proxied("127.0.0.1", "198.51.100.99, 203.0.113.40"))).toEqual({ address: "203.0.113.40" });
  expect(trustedNetworkFromRequest(proxied("::ffff:127.0.0.1", "198.51.100.99, 203.0.113.40, 10.1.2.3"))).toEqual({ address: "203.0.113.40" });
  // Forwarding data from a peer that is not a trusted proxy is ignored.
  expect(trustedNetworkFromRequest(proxied("203.0.113.9", "198.51.100.99"))).toEqual({ address: "203.0.113.9" });
  expect(trustedNetworkFromRequest(proxied("127.0.0.1"))).toEqual({ address: "127.0.0.1" });
});

it("falls back to the proxy address for malformed or oversized forwarding data", async () => {
  vi.stubEnv("TRUSTED_PROXY_ADDRESSES", "127.0.0.1");
  const { trustedNetworkFromRequest } = await import("./auth.js");
  for (const forwarded of ["999.1.1.1", "fe80::1%eth0", "not-an-ip", "203.0.113.40, ", `203.0.113.40${", 203.0.113.41".repeat(40)}`, Array.from({ length: 17 }, (_, index) => `203.0.113.${index}`).join(",")]) {
    expect(trustedNetworkFromRequest(proxied("127.0.0.1", forwarded))).toEqual({ address: "127.0.0.1" });
  }
});

it("gives equivalent address spellings one rate-limit identity", async () => {
  vi.stubEnv("TRUSTED_PROXY_ADDRESSES", "127.0.0.1");
  const { canonicalIp, trustedNetworkFromRequest } = await import("./auth.js");
  expect(canonicalIp("::ffff:203.0.113.40")).toBe("203.0.113.40");
  expect(canonicalIp("::FFFF:CB00:7128")).toBe("203.0.113.40");
  expect(canonicalIp("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
  expect(canonicalIp("2001:db8::0:1")).toBe("2001:db8::1");
  expect(canonicalIp("01.2.3.4")).toBeNull();
  expect(canonicalIp("fe80::1%eth0")).toBeNull();
  expect(trustedNetworkFromRequest(proxied("127.0.0.1", "2001:DB8:0:0:0:0:0:1"))).toEqual({ address: "2001:db8::1" });
});

it("trusts IPv6 proxy subnets and ignores invalid proxy configuration", async () => {
  vi.stubEnv("TRUSTED_PROXY_ADDRESSES", "2001:db8:ffff::/48");
  const { trustedNetworkFromRequest } = await import("./auth.js");
  expect(trustedNetworkFromRequest(proxied("2001:db8:ffff::2", "2001:db8:1::5"))).toEqual({ address: "2001:db8:1::5" });
  vi.stubEnv("TRUSTED_PROXY_ADDRESSES", "not-an-ip, 10.0.0.0/99");
  expect(trustedNetworkFromRequest(proxied("10.0.0.5", "198.51.100.1"))).toEqual({ address: "10.0.0.5" });
});

it("counts an IPv6 client by its /64 and an IPv4 client by its address", async () => {
  const { rateAddress } = await import("./auth.js");
  expect(rateAddress("203.0.113.40")).toBe("203.0.113.40");
  expect(rateAddress("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
  expect(rateAddress("2001:db8:1:2::ffff")).toBe(rateAddress("2001:db8:1:2:aaaa::1"));
  expect(rateAddress("unknown")).toBe("unknown");
});

it("audits the trusted-chain client address, not a client-supplied one", async () => {
  vi.stubEnv("TRUSTED_PROXY_ADDRESSES", "127.0.0.1");
  const { audit } = await import("./auth.js");
  const spoofed = { ...proxied("127.0.0.1", "6.6.6.6, 203.0.113.91"), ip: "6.6.6.6" };
  await audit(spoofed, "auth.login", "user", "user-1");
  expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ ip: "203.0.113.91" }) });
});

it("runs the same statements for every failed verification, known address or not", async () => {
  vi.stubEnv("AUTH_CODE_HASH_KEY", "unit-code-key");
  vi.stubEnv("AUTH_RATE_HASH_KEY", "unit-rate-key");
  const { verifyLoginCode } = await import("./auth.js");
  const user = { id: "user-1", email: "known@example.test", name: "Known", role: "AGENT", active: true };
  const code = { id: "code-1", codeHash: "ab".repeat(32) };
  const cases = {
    unknown: { user: null, currentUser: null, candidate: null },
    disabled: { user: { id: user.id }, currentUser: { ...user, active: false }, candidate: code },
    withoutCode: { user: { id: user.id }, currentUser: user, candidate: null },
    wrongCode: { user: { id: user.id }, currentUser: user, candidate: code }
  };
  const runs: Record<string, string[]> = {};
  for (const [name, state] of Object.entries(cases)) {
    Object.assign(rows, state);
    statements.length = 0;
    await expect(verifyLoginCode(`${name}@example.test`, "123456", { address: "203.0.113.9" })).resolves.toBeNull();
    runs[name] = [...statements];
  }
  expect(runs.unknown).toContain("loginCode.updateMany");
  for (const name of ["disabled", "withoutCode", "wrongCode"]) expect(runs[name]).toEqual(runs.unknown);
});
