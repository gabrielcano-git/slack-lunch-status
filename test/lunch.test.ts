import assert from "node:assert/strict";
import test from "node:test";
import { LUNCH_STATUS, LunchService, restoreStatus } from "../src/lunch.js";
import type { LunchRecord, Phase, SlackStatus, StateStore, StatusClient } from "../src/types.js";

const OLD: SlackStatus = { status_text: "Focado", status_emoji: ":computer:", status_expiration: 0 };
const date = () => new Date("2026-11-12T15:00:00.000Z"); // noon in São Paulo

class MemorySlack implements StatusClient {
  status: SlackStatus = { ...OLD };
  calls = 0;
  async get() { return { ...this.status }; }
  async set(value: SlackStatus) { this.calls++; this.status = { ...value }; }
}
class MemoryStore implements StateStore {
  data = new Map<string, LunchRecord>();
  async get(day: string) { return this.data.get(day) ?? null; }
  async createIfAbsent(day: string, r: LunchRecord) {
    if (!this.data.has(day)) this.data.set(day, r);
    return this.data.get(day)!;
  }
  async transition(day: string, expected: Phase, next: Phase, result?: LunchRecord["result"]) {
    const r = this.data.get(day);
    if (!r || r.phase !== expected) return false;
    this.data.set(day, { ...r, phase: next, ...(result ? { result } : {}) });
    return true;
  }
}

test("saves old status and restores it after lunch", async () => {
  const slack = new MemorySlack(); const state = new MemoryStore();
  const svc = new LunchService(slack, state, date);
  assert.equal(await svc.start(), "started");
  assert.deepEqual(slack.status, LUNCH_STATUS);
  assert.equal(await svc.end(), "restored");
  assert.deepEqual(slack.status, OLD);
});

test("retries never overwrite original backup or start twice", async () => {
  const slack = new MemorySlack(); const svc = new LunchService(slack, new MemoryStore(), date);
  await svc.start();
  assert.equal(await svc.start(), "noop:active");
  await svc.end();
  assert.equal(await svc.start(), "noop:done");
  assert.equal(slack.calls, 2);
});

test("manual status change during lunch is preserved", async () => {
  const slack = new MemorySlack(); const svc = new LunchService(slack, new MemoryStore(), date);
  await svc.start();
  slack.status = { status_text: "Em reunião", status_emoji: ":calendar:", status_expiration: 0 };
  assert.equal(await svc.end(), "manual_change");
  assert.equal(slack.status.status_text, "Em reunião");
});

test("manually cleared status is preserved", async () => {
  const slack = new MemorySlack(); const svc = new LunchService(slack, new MemoryStore(), date);
  await svc.start(); slack.status = { status_text: "", status_emoji: "", status_expiration: 0 };
  assert.equal(await svc.end(), "manual_change");
  assert.equal(slack.status.status_text, "");
});

test("expired original status is cleared instead of resurrected", async () => {
  const old = { status_text: "Ocupado", status_emoji: ":no_entry:", status_expiration: 1 };
  assert.deepEqual(restoreStatus(old, date()), { status_text: "", status_emoji: "", status_expiration: 0 });
});

test("end without start is harmless", async () => {
  const svc = new LunchService(new MemorySlack(), new MemoryStore(), date);
  assert.equal(await svc.end(), "noop:not_started");
});

test("recovers a partially completed start", async () => {
  const slack = new MemorySlack(); const store = new MemoryStore();
  const day = "2026-11-12";
  store.data.set(day, { phase: "starting", previous: { ...OLD }, createdAt: date().toISOString(), updatedAt: date().toISOString() });
  slack.status = { ...LUNCH_STATUS };
  const svc = new LunchService(slack, store, date);
  assert.equal(await svc.start(), "started");
  assert.equal(await svc.end(), "restored");
});
