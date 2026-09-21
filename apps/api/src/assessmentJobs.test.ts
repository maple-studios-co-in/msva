import { describe, expect, it } from "vitest";
import { readAutomaticAssessmentConfig } from "./assessmentJobs.js";

describe("automatic assessment configuration", () => {
  it("disables scheduling when automatic mode is off", () => {
    expect(readAutomaticAssessmentConfig({ JEV_AUTO_POST_CALL_ENABLED: "false" })).toMatchObject({ enabled: false, reason: "DISABLED" });
  });

  it("rejects an invalid activation timestamp without affecting manual capability", () => {
    expect(readAutomaticAssessmentConfig({ JEV_AUTO_POST_CALL_ENABLED: "true", JEV_AUTO_START_AT: "not-a-date" })).toMatchObject({ enabled: false, reason: "INVALID_START_AT" });
  });

  it("requires an activation timestamp when enabled", () => {
    expect(readAutomaticAssessmentConfig({ JEV_AUTO_POST_CALL_ENABLED: "true" })).toMatchObject({ enabled: false, reason: "MISSING_START_AT" });
  });
});
