export interface SlackStatus {
  status_text: string;
  status_emoji: string;
  status_expiration: number;
}

export type Phase = "starting" | "active" | "restoring" | "done";

export interface LunchRecord {
  phase: Phase;
  previous: SlackStatus;
  createdAt: string;
  updatedAt: string;
  result?: "restored" | "manual_change" | "cancelled";
}

export interface StatusClient {
  get(): Promise<SlackStatus>;
  set(status: SlackStatus): Promise<void>;
}

export interface StateStore {
  get(day: string): Promise<LunchRecord | null>;
  /** Atomically create the first record for a given local date, or return the existing record. */
  createIfAbsent(day: string, record: LunchRecord): Promise<LunchRecord>;
  /** Atomically change phase only if it is the expected previous phase. */
  transition(day: string, expected: Phase, next: Phase, result?: LunchRecord["result"]): Promise<boolean>;
}
