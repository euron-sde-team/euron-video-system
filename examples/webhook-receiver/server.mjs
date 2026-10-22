// Reference webhook receiver for Euron Video System. Zero dependencies.
//
// Shows the three things every receiver should do:
//   1. verify EVS-Signature over the RAW body (not re-serialized JSON),
//   2. reject stale timestamps (replay protection, no nonce store needed),
//   3. deduplicate by EVS-Event-Id (deliveries are at-least-once; retries reuse the id).
//
//   WEBHOOK_SIGNING_SECRET=whsec_... node examples/webhook-receiver/server.mjs
//
// Respond 2xx fast and do real work asynchronously: anything else is retried
// with backoff by the dispatcher.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 9099);
const SECRET = process.env.WEBHOOK_SIGNING_SECRET ?? "";
const TOLERANCE_SECONDS = 300;
const seen = new Set(); // use a durable store (unique index) in production

/** Returns null when valid, else the reason it is not. */
export const verify = (secret, rawBody, header, nowSeconds = Math.floor(Date.now() / 1000)) => {
  if (!header) return "missing EVS-Signature";
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return "malformed EVS-Signature";
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return "timestamp outside tolerance (possible replay)";
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  const provided = Buffer.from(parts.v1);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return "signature mismatch";
  return null;
};

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") return res.writeHead(200).end("ok");
  if (req.method !== "POST") return res.writeHead(405).end();

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const eventId = req.headers["evs-event-id"];
    const type = req.headers["evs-event-type"];

    const problem = SECRET ? verify(SECRET, raw, req.headers["evs-signature"]) : "WEBHOOK_SIGNING_SECRET not set";
    if (problem) {
      console.log(JSON.stringify({ accepted: false, type, eventId, reason: problem }));
      return res.writeHead(400).end(problem);
    }
    if (seen.has(eventId)) {
      console.log(JSON.stringify({ accepted: true, duplicate: true, type, eventId }));
      return res.writeHead(200).end("duplicate");
    }
    seen.add(eventId);
    const event = JSON.parse(raw);
    console.log(JSON.stringify({ accepted: true, type, eventId, data: event.data }));
    res.writeHead(204).end();
  });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => console.log(`webhook receiver listening on :${PORT}`));
}
