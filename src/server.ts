import { createServer } from "node:http";
import { LunchService } from "./lunch.js";
import { SlackClient } from "./slack.js";
import { FirestoreStore } from "./store.js";

const token = process.env.SLACK_USER_TOKEN;
if (!token) throw new Error("Missing SLACK_USER_TOKEN");
const service = new LunchService(new SlackClient(token), new FirestoreStore());
const port = Number(process.env.PORT ?? 8080);

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const reply = (status: number, value: object) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };
  if (req.method === "GET" && path === "/health") return reply(200, { ok: true });
  if (req.method !== "POST" || !["/lunch/start", "/lunch/end"].includes(path)) {
    return reply(404, { error: "not_found" });
  }
  try {
    const result = path === "/lunch/start" ? await service.start() : await service.end();
    console.info(JSON.stringify({ event: path, result }));
    return reply(200, { ok: true, result });
  } catch (error) {
    console.error("Request failed", error);
    return reply(500, { ok: false, error: "internal_error" });
  }
});
server.listen(port, "0.0.0.0", () => console.log(`Listening on ${port}`));
