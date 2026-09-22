import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("sends the console session and explains a refused request", async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ error: "Sign in required" }, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  const { SIGN_IN_REQUIRED, consoleSignedIn, previewVoice, sendMessage, setLlmMode } = await import("./api");
  await expect(sendMessage("call-123456", "hello", {} as never)).rejects.toThrow(SIGN_IN_REQUIRED);
  await expect(previewVoice("anushka", "Namaste")).rejects.toThrow(SIGN_IN_REQUIRED);
  await expect(setLlmMode(false)).rejects.toThrow(SIGN_IN_REQUIRED);
  for (const [, init] of fetchMock.mock.calls) expect(init).toMatchObject({ credentials: "include" });
  expect(await consoleSignedIn()).toBe(false);
  fetchMock.mockResolvedValueOnce(Response.json({ user: { role: "VIEWER" } }));
  expect(await consoleSignedIn()).toBe(true);
});
