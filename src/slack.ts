import type { SlackStatus, StatusClient } from "./types.js";

const baseUrl = "https://slack.com/api";

export class SlackClient implements StatusClient {
  constructor(private readonly token: string) {
    if (!token.startsWith("xoxp-")) throw new Error("SLACK_USER_TOKEN must be a Slack user token (xoxp-...)");
  }

  private async call(method: string, body?: object): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Slack HTTP ${response.status} for ${method}`);
    const result = (await response.json()) as Record<string, unknown>;
    if (result.ok !== true) throw new Error(`Slack ${method}: ${String(result.error ?? "unknown error")}`);
    return result;
  }

  async get(): Promise<SlackStatus> {
    const result = await this.call("users.profile.get");
    const profile = result.profile as Record<string, unknown> | undefined;
    if (!profile) throw new Error("Slack returned an empty profile");
    return {
      status_text: String(profile.status_text ?? ""),
      status_emoji: String(profile.status_emoji ?? ""),
      status_expiration: Number(profile.status_expiration ?? 0)
    };
  }

  async set(profile: SlackStatus): Promise<void> {
    await this.call("users.profile.set", { profile });
  }
}
