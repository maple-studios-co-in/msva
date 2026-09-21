import { expect, it, vi } from "vitest";

vi.mock("@msva/db", () => ({ prisma: {} }));

function request(headers: Record<string, string | undefined>) {
  return { headers } as any;
}

it("rejects malformed, duplicate, and ambiguous session credentials safely", async () => {
  const { tokenFromRequest } = await import("./auth.js");
  expect(tokenFromRequest(request({ cookie: "msva_session=%E0%A4%A" }))).toBeNull();
  expect(tokenFromRequest(request({ cookie: "msva_session=a; msva_session=b" }))).toBeNull();
  expect(tokenFromRequest(request({ cookie: "msva_session=a", authorization: "Bearer b" }))).toBeNull();
});
