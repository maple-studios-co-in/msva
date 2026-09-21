import type { CallAssessmentResponse } from "@msva/shared";
import { assessmentWakeDelay } from "./assessmentView.js";

type Options = {
  load: (signal: AbortSignal) => Promise<CallAssessmentResponse>;
  onResponse: (response: CallAssessmentResponse) => void;
  onReadError: (error: unknown) => void;
  onLeaseExpiry: () => void;
  now?: () => number;
};

export class AssessmentPollController {
  private response: CallAssessmentResponse | null = null;
  private request: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => Date.now());
  }

  start() {
    this.read();
  }

  refresh() {
    if (this.stopped) return;
    this.clearPollTimer();
    this.request?.abort();
    this.read();
  }

  accept(response: CallAssessmentResponse) {
    if (this.stopped) return;
    this.request?.abort();
    this.request = null;
    this.response = response;
    this.options.onResponse(response);
    this.schedule();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.request?.abort();
    this.request = null;
  }

  private read() {
    if (this.stopped) return;
    this.clearPollTimer();
    const controller = new AbortController();
    this.request?.abort();
    this.request = controller;
    void this.options.load(controller.signal)
      .then((response) => {
        if (this.stopped || this.request !== controller) return;
        this.accept(response);
      })
      .catch((error) => {
        if (this.stopped || this.request !== controller || controller.signal.aborted) return;
        this.options.onReadError(error);
      })
      .finally(() => {
        if (this.stopped || this.request !== controller) return;
        this.request = null;
        this.schedule();
      });
  }

  private schedule() {
    this.clearTimers();
    if (this.stopped || !this.response) return;
    const now = new Date(this.now());
    const delay = assessmentWakeDelay(this.response, now);
    if (delay !== null) this.pollTimer = setTimeout(() => this.read(), delay);

    const leaseExpiresAt = this.response.assessment?.status === "RUNNING" ? this.response.assessment.leaseExpiresAt : null;
    if (!leaseExpiresAt) return;
    const untilExpiry = new Date(leaseExpiresAt).getTime() - now.getTime();
    if (untilExpiry <= 0) {
      this.expireLease();
      return;
    }
    this.expiryTimer = setTimeout(() => this.expireLease(), untilExpiry);
  }

  private expireLease() {
    if (this.stopped) return;
    this.clearPollTimer();
    this.request?.abort();
    this.request = null;
    this.options.onLeaseExpiry();
  }

  private clearPollTimer() {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private clearTimers() {
    this.clearPollTimer();
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }
}
