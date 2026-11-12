import { Firestore } from "@google-cloud/firestore";
import type { LunchRecord, Phase, StateStore } from "./types.js";

export class FirestoreStore implements StateStore {
  private readonly firestore = new Firestore();
  private readonly collection = this.firestore.collection(process.env.FIRESTORE_COLLECTION ?? "slack-lunch-status");

  async get(day: string): Promise<LunchRecord | null> {
    const snapshot = await this.collection.doc(day).get();
    return snapshot.exists ? snapshot.data() as LunchRecord : null;
  }

  async createIfAbsent(day: string, record: LunchRecord): Promise<LunchRecord> {
    const ref = this.collection.doc(day);
    return this.firestore.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (current.exists) return current.data() as LunchRecord;
      tx.create(ref, record);
      return record;
    });
  }

  async transition(day: string, expected: Phase, next: Phase, result?: LunchRecord["result"]): Promise<boolean> {
    const ref = this.collection.doc(day);
    return this.firestore.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.data()?.phase !== expected) return false;
      tx.update(ref, {
        phase: next,
        updatedAt: new Date().toISOString(),
        ...(result ? { result } : {})
      });
      return true;
    });
  }
}
