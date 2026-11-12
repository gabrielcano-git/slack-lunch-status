import type { LunchRecord, SlackStatus, StateStore, StatusClient } from "./types.js";

export const LUNCH_STATUS: SlackStatus = {
  status_text: "Almoçando",
  status_emoji: ":fork_and_knife:",
  // No automatic expiration: a manually cleared status must stay cleared.
  status_expiration: 0
};

export function localDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const value = (kind: string) => parts.find(p => p.type === kind)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function sameStatus(a: SlackStatus, b: SlackStatus): boolean {
  return a.status_text === b.status_text && a.status_emoji === b.status_emoji &&
    a.status_expiration === b.status_expiration;
}

function isLunch(s: SlackStatus): boolean {
  return sameStatus(s, LUNCH_STATUS);
}

export function restoreStatus(previous: SlackStatus, now: Date): SlackStatus {
  if (previous.status_expiration > 0 && previous.status_expiration <= Math.floor(now.getTime() / 1000)) {
    return { status_text: "", status_emoji: "", status_expiration: 0 };
  }
  return previous;
}

export class LunchService {
  constructor(
    private readonly slack: StatusClient,
    private readonly store: StateStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async start(): Promise<string> {
    const now = this.now();
    const day = localDay(now);
    const existing = await this.store.get(day);
    if (existing?.phase === "active" || existing?.phase === "restoring" || existing?.phase === "done") {
      return `noop:${existing.phase}`;
    }

    // Store original state before writing to Slack. Transaction protects against duplicate calls.
    const current = await this.slack.get();
    const record: LunchRecord = existing ?? await this.store.createIfAbsent(day, {
      phase: "starting", previous: current,
      createdAt: now.toISOString(), updatedAt: now.toISOString()
    });
    if (record.phase !== "starting") return `noop:${record.phase}`;

    // A retry after a successful Slack call can finalize the partially completed operation.
    const observed = await this.slack.get();
    if (isLunch(observed)) {
      await this.store.transition(day, "starting", "active");
      return "started";
    }
    // The profile changed independently after backup: don't override the manual change.
    if (!sameStatus(observed, record.previous)) {
      await this.store.transition(day, "starting", "done", "manual_change");
      return "manual_change";
    }

    await this.slack.set(LUNCH_STATUS);
    await this.store.transition(day, "starting", "active");
    return "started";
  }

  async end(): Promise<string> {
    const day = localDay(this.now());
    let record = await this.store.get(day);
    if (!record) return "noop:not_started";
    if (record.phase === "done") return "noop:done";
    if (record.phase === "starting") {
      const current = await this.slack.get();
      if (!isLunch(current)) {
        await this.store.transition(day, "starting", "done", "cancelled");
        return "noop:not_started";
      }
      await this.store.transition(day, "starting", "active");
      record = await this.store.get(day);
    }
    if (!record || (record.phase !== "active" && record.phase !== "restoring")) return "noop:concurrent";

    const current = await this.slack.get();
    const previous = restoreStatus(record.previous, this.now());
    if (!isLunch(current)) {
      // If a retry occurred after restoration, status may already equal previous.
      const result = sameStatus(current, previous) && record.phase === "restoring" ? "restored" : "manual_change";
      await this.store.transition(day, record.phase, "done", result);
      return result;
    }
    if (record.phase === "active") {
      if (!await this.store.transition(day, "active", "restoring")) return "noop:concurrent";
    }
    // Check again after reserving the transition, protecting a manual change during the read.
    const latest = await this.slack.get();
    if (!isLunch(latest)) {
      await this.store.transition(day, "restoring", "done", "manual_change");
      return "manual_change";
    }
    await this.slack.set(previous);
    await this.store.transition(day, "restoring", "done", "restored");
    return "restored";
  }
}
