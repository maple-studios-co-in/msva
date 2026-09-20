import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAssessmentSnapshot, capabilityFor, invokeJev, JEV_QUESTIONS, readJevConfig, toCallAssessmentDto, validateProviderResult } from "./callAssessment.js";

const choice = <T extends string>(value: T, choices: readonly T[]) => ({
  type: "choice",
  choice: value,
  probabilities: Object.fromEntries(choices.map((entry) => [entry, entry === value ? 1 : 0])),
  confidence: 1
});

describe("post-call assessment snapshots", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("orders saved utterances by sequence and does not duplicate Turn text", () => {
    const snapshot = buildAssessmentSnapshot({
      id: "call-1",
      status: "COMPLETED",
      endedAt: new Date("2026-09-21T00:00:00.000Z"),
      language: "hi",
      callerName: "Asha",
      caller: null,
      fromNumber: "+919876543210",
      utterances: [
        { id: "b", seq: 2, speaker: "AGENT", text: "Ticket recorded" },
        { id: "a", seq: 1, speaker: "CALLER", text: "My number is 9876543210" }
      ],
      tickets: []
    });

    expect(snapshot.eligibility).toEqual({ eligible: true, reason: null });
    expect(snapshot.input.transcript).toBe("CALLER: My number is [PHONE]\nAGENT: Ticket recorded");
    expect(snapshot.input.linkedTicketRecorded).toBe(false);
  });

  it("accepts only typed complete provider choices and derives ticket-claim evidence", () => {
    const answers = {
      repetition: choice("not_repetitive", ["repetitive", "not_repetitive", "insufficient_context"] as const),
      callerSentiment: choice("neutral", ["positive", "neutral", "frustrated", "unclear"] as const),
      followUpNeed: choice("unclear", ["indicated", "not_indicated", "unclear"] as const),
      ticketCreationClaim: choice("claimed", ["claimed", "not_claimed", "unclear"] as const),
      journey: choice("unclear", ["consumer_complaint", "retailer_enquiry", "distributor_support", "sales_interest", "unclear"] as const),
      urgency: choice("routine", ["possible_safety", "routine", "unclear"] as const)
    };
    const validated = validateProviderResult({ model: "jev-1.13.0", answers, usage: { input_tokens: 12, output_tokens: 8 } }, false);
    expect(validated.result.possibleUnsupportedTicketClaim).toBe(true);
    expect(validated).toMatchObject({ promptTokens: 12, completionTokens: 8 });
    expect(validated.result.repetition).not.toHaveProperty("type");
    expect(() => validateProviderResult({ model: "jev-1.13.0", answers: { ...answers, urgency: undefined } }, false)).toThrow("RESPONSE_INVALID");
    expect(() => validateProviderResult({ model: "jev-1.13.0", answers: { ...answers, repetition: { ...answers.repetition, type: "text" } } }, false)).toThrow("RESPONSE_INVALID");
    expect(() => validateProviderResult({
      model: "jev-1.13.0",
      answers: {
        ...answers,
        callerSentiment: { ...answers.callerSentiment, choice: "neutral", probabilities: { positive: 1, neutral: 0, frustrated: 0, unclear: 0 } }
      }
    }, false)).toThrow("RESPONSE_INVALID");
    expect(() => validateProviderResult({
      model: "jev-1.13.0",
      answers: { ...answers, urgency: { ...answers.urgency, probabilities: { possible_safety: 0.5, routine: 0.5 } } }
    }, false)).toThrow("RESPONSE_INVALID");
    expect(() => validateProviderResult({
      model: "jev-1.13.0",
      answers: { ...answers, repetition: { ...answers.repetition, probabilities: { repetitive: 0.8, not_repetitive: 0.8, insufficient_context: 0 } } }
    }, false)).toThrow("RESPONSE_INVALID");
  });

  it("sends concrete typed questions and exposes failed retryability only after cooldown", () => {
    for (const question of Object.values(JEV_QUESTIONS)) {
      expect(question.type).toBe("choice");
      expect(question.instructions).toContain("transcript");
      expect(Object.keys(question.criteria).length).toBeGreaterThan(0);
    }
    const requestedAt = new Date("2026-09-21T00:00:00.000Z");
    const record = {
      id: "assessment-1", callId: "call-1", status: "FAILED" as const, requestedAt,
      completedAt: new Date("2026-09-21T00:00:10.000Z"), leaseExpiresAt: null,
      requestedModel: "jev-1.13.0", returnedModel: null, rubricVersion: "msva-post-call-v1",
      inputHash: "a".repeat(64), attemptToken: "attempt-1", errorCode: "TIMEOUT", result: null
    };
    expect(toCallAssessmentDto(record, new Date("2026-09-21T00:00:39.999Z")).retryable).toBe(false);
    expect(toCallAssessmentDto(record, new Date("2026-09-21T00:00:40.000Z")).retryable).toBe(true);
  });

  it("keeps the provider unavailable until every server-side setting is present", () => {
    expect(capabilityFor({ enabled: false, apiKey: "key", allowedOrigins: new Set(["https://console.example"]) })).toMatchObject({ available: false, reason: "DISABLED" });
    expect(capabilityFor({ enabled: true, apiKey: null, allowedOrigins: new Set(["https://console.example"]) })).toMatchObject({ available: false, reason: "MISSING_API_KEY" });
  });

  it("redacts case variants of both Call and linked Caller names before any provider payload", () => {
    const snapshot = buildAssessmentSnapshot({
      id: "call-redaction", status: "COMPLETED", endedAt: new Date(), language: "en",
      callerName: null, caller: { name: "Asha Sharma" }, fromNumber: "+919876543210", tickets: [],
      utterances: [{ id: "1", seq: 1, speaker: "CALLER", text: "asha sharma emailed a@example.test from 9876543210; ASHA SHARMA needs help." }]
    });
    expect(snapshot.input.transcript).toBe("CALLER: [REDACTED] emailed [EMAIL] from [PHONE]; [REDACTED] needs help.");
  });

  it("cancels and aborts an oversized provider stream, and bounds a hanging provider", async () => {
    const config = readJevConfig({ JEV_ENABLED: "true", JEV_API_KEY: "test-key", JEV_ALLOWED_ORIGINS: "https://console.test" });
    const input = { transcript: "CALLER: test", language: "en", linkedTicketRecorded: false, utteranceCount: 1 };
    let cancelled = false;
    let aborted = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(100_001))); },
      cancel() { cancelled = true; }
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => { aborted = true; });
      return new Response(body, { status: 200 });
    }));
    await expect(invokeJev(input, config)).rejects.toThrow("RESPONSE_INVALID");
    expect(cancelled).toBe(true);
    expect(aborted).toBe(true);

    let timeoutAbort = false;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        timeoutAbort = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    })));
    await expect(invokeJev(input, config, { timeoutMs: 5 })).rejects.toThrow("TIMEOUT");
    expect(timeoutAbort).toBe(true);
  });
});
