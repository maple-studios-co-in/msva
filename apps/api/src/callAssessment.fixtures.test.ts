import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAssessmentSnapshot, invokeJev, readJevConfig } from "./callAssessment.js";
import { runSyntheticFixtureHarness, syntheticAssessmentFixtures, type SyntheticAssessmentFixture } from "./callAssessment.fixtures.js";

const options = {
  repetition: ["repetitive", "not_repetitive", "insufficient_context"],
  callerSentiment: ["positive", "neutral", "frustrated", "unclear"],
  followUpNeed: ["indicated", "not_indicated", "unclear"],
  ticketCreationClaim: ["claimed", "not_claimed", "unclear"],
  journey: ["consumer_complaint", "retailer_enquiry", "distributor_support", "sales_interest", "unclear"],
  urgency: ["possible_safety", "routine", "unclear"]
} as const;

const choice = <T extends string>(value: T, values: readonly T[]) => ({
  type: "choice",
  choice: value,
  probabilities: Object.fromEntries(values.map((entry) => [entry, entry === value ? 1 : 0])),
  confidence: 1
});

function providerPayload(fixture: SyntheticAssessmentFixture) {
  return {
    model: "jev-1.13.0",
    answers: {
      repetition: choice(fixture.expected.repetition, options.repetition),
      callerSentiment: choice("neutral", options.callerSentiment),
      followUpNeed: choice("not_indicated", options.followUpNeed),
      ticketCreationClaim: choice(fixture.expected.ticketCreationClaim, options.ticketCreationClaim),
      journey: choice("retailer_enquiry", options.journey),
      urgency: choice("routine", options.urgency)
    },
    usage: { input_tokens: 1, output_tokens: 1 }
  };
}

function snapshotFor(fixture: SyntheticAssessmentFixture) {
  return buildAssessmentSnapshot({
    id: fixture.id,
    status: "COMPLETED",
    endedAt: new Date("2026-09-21T00:00:00.000Z"),
    language: fixture.id.includes("hindi") ? "hi" : "en",
    callerName: null,
    caller: null,
    fromNumber: "browser",
    tickets: fixture.linkedTicketRecorded ? [{}] : [],
    utterances: fixture.transcript.split("\n").map((line, index) => {
      const [speaker, ...text] = line.split(": ");
      return { id: `${fixture.id}-${index}`, seq: index + 1, speaker, text: text.join(": ") };
    })
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("synthetic post-call assessment fixture harness", () => {
  it("runs labelled synthetic transcripts through preprocessing and the typed offline adapter", async () => {
    const fixtureByTranscript = new Map(syntheticAssessmentFixtures.map((fixture) => [snapshotFor(fixture).input.transcript, fixture]));
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      const fixture = fixtureByTranscript.get(request.state.transcript);
      if (!fixture) throw new Error("unexpected synthetic transcript");
      return new Response(JSON.stringify(providerPayload(fixture)), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = readJevConfig({ JEV_ENABLED: "true", JEV_API_KEY: "fixture-key", JEV_ALLOWED_ORIGINS: "https://console.test" });

    const results = await runSyntheticFixtureHarness(async (fixture) => {
      const snapshot = snapshotFor(fixture);
      expect(snapshot.eligibility.eligible).toBe(true);
      return invokeJev(snapshot.input, config);
    });

    expect(fetchMock).toHaveBeenCalledTimes(syntheticAssessmentFixtures.length);
    for (const { fixture, response } of results) {
      expect(response.result.repetition.choice).toBe(fixture.expected.repetition);
      expect(response.result.ticketCreationClaim.choice).toBe(fixture.expected.ticketCreationClaim);
      expect(response.result.possibleUnsupportedTicketClaim).toBe(
        fixture.expected.ticketCreationClaim === "claimed" && !fixture.linkedTicketRecorded
      );
    }
    expect(syntheticAssessmentFixtures.map((fixture) => fixture.focus)).toEqual(expect.arrayContaining([
      "repeated agent availability response", "routine Devanagari Hindi enquiry",
      "caller ticket request is not an agent completion claim",
      "agent completed-ticket assertion without persisted ticket"
    ]));
  });
});
