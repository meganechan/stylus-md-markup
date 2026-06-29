// Review Desk backend — TOKEN-ONLY mode (capability links).
//
// A review is opened by its per-Round token in the URL (/r/:token). The token is
// the capability (256-bit, unguessable, validated by maw) — there is NO passphrase
// login and NO public inbox. The browser hits the desk; the desk proxies maw
// server-to-server with MAW_REVIEW_DESK_SECRET (env-only, never to the browser),
// passing the :token along for maw to validate.
//
// Hardening (token lives in the URL): Referrer-Policy: no-referrer on the desk page
// (so the token never leaks via Referer to external resources), and the token is
// never logged.
//
// maw contract consumed: GET /api/review/:token · POST /api/review/:token/decision.

import type { Hono, Context } from "hono";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const MAW_REVIEW_DESK_SECRET = process.env.MAW_REVIEW_DESK_SECRET ?? "";
// maw review-plane base URL (desk → maw proxy target). Env only, no hardcode.
const MAW_BASE_URL = (process.env.MAW_BASE_URL ?? "").replace(/\/$/, "");

const mawConfigured = () => Boolean(MAW_BASE_URL && MAW_REVIEW_DESK_SECRET);

function mawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${MAW_BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${MAW_REVIEW_DESK_SECRET}` },
  });
}

export function registerReviewDesk(app: Hono, webDir: string) {
  // Serve the desk HTML with Referrer-Policy: no-referrer so the token in the URL
  // is never sent as a Referer when the page loads external resources (md images).
  async function serveDeskHtml(c: Context) {
    c.header("Referrer-Policy", "no-referrer");
    const html = await readFile(join(webDir, "review.html"), "utf8");
    return c.html(html);
  }

  // token-only UI: /r/:token opens one review; /review shows a notice (no inbox).
  app.get("/r/:token", serveDeskHtml);
  app.get("/review", serveDeskHtml);

  // Public inbox is DISABLED in token-only mode — never list all reviews/tokens.
  app.get("/api/pending", (c) => c.json({ error: "disabled in token-only mode" }, 404));
  app.get("/api/stream", (c) => c.json({ error: "disabled in token-only mode" }, 404));

  // GET /api/review/:token — capability-authorized by the token (maw validates it);
  // the desk only adds the server-side secret for the proxy hop. No session.
  app.get("/api/review/:token", async (c) => {
    if (!mawConfigured()) return c.json({ error: "maw not configured" }, 503);
    try {
      const r = await mawFetch(`/api/review/${encodeURIComponent(c.req.param("token"))}`);
      return c.json(await r.json(), r.status as 200);
    } catch (e) {
      return c.json({ error: "maw unreachable: " + (e as Error).message }, 502);
    }
  });

  // POST /api/review/:token/decision — relay the Decision (+ opaque feedback).
  app.post("/api/review/:token/decision", async (c) => {
    if (!mawConfigured()) return c.json({ error: "maw not configured" }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    try {
      const r = await mawFetch(`/api/review/${encodeURIComponent(c.req.param("token"))}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return c.json(await r.json().catch(() => ({})), r.status as 200);
    } catch (e) {
      return c.json({ error: "maw unreachable: " + (e as Error).message }, 502);
    }
  });
}
