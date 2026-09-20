import { describe, expect, it } from "vitest";
import { runSyntheticFixtureHarness, syntheticAssessmentFixtures } from "./callAssessment.fixtures.js";

describe("synthetic post-call assessment fixture harness", () => {
  it("keeps the English, Hindi, Hinglish, ASR, safety, negation, injection, and ticket scenarios offline", async () => {
    let adapterCalls = 0;
    const results = await runSyntheticFixtureHarness(async (fixture) => {
      adapterCalls += 1;
      return { id: fixture.id, sentToVendor: false };
    });
    expect(adapterCalls).toBe(syntheticAssessmentFixtures.length);
    expect(results.map((result) => result.response)).toEqual(syntheticAssessmentFixtures.map((fixture) => ({ id: fixture.id, sentToVendor: false })));
    expect(syntheticAssessmentFixtures.map((fixture) => fixture.focus)).toEqual(expect.arrayContaining([
      "repetition", "routine Hindi enquiry", "frustration without danger", "mixed ASR-style routine enquiry",
      "possible safety wording", "negation and quotation", "embedded instruction",
      "ticket claim without persisted ticket", "ticket claim with persisted ticket"
    ]));
  });
});
