// Review Desk backend (second surface of this repo — ADR-0002).
//
// A human-in-the-loop approval gate. The browser talks ONLY to this backend
// (gated by a passphrase session); this backend talks to maw server-to-server
// with MAW_REVIEW_DESK_SECRET (a shared secret, env-only, never sent to the
// browser). It proxies the maw review plane and relays its SSE stream, adding a
// heartbeat so long-lived connections survive idle proxies.
//
// maw contract (consumed): GET /api/review/pending · GET /api/review/stream (SSE)
// · GET /api/review/:token · POST /api/review/:token/decision {outcome, feedback}.

import type { Hono, Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "hono/bun";
import { createHmac, timingSafeEqual } from "node:crypto";
import { join, relative } from "node:path";

const MAW_REVIEW_DESK_SECRET = process.env.MAW_REVIEW_DESK_SECRET ?? "";
// maw review-plane base URL (desk → maw proxy target). Env only, no hardcode —
// value chosen once Tony picks the maw home. Empty → maw routes return 503.
const MAW_BASE_URL = (process.env.MAW_BASE_URL ?? "").replace(/\/$/, "");
const DESK_PASSPHRASE = process.env.DESK_PASSPHRASE ?? "";
const COOKIE = "desk_session";

const deskEnabled = () => Boolean(DESK_PASSPHRASE);
const mawConfigured = () => Boolean(MAW_BASE_URL && MAW_REVIEW_DESK_SECRET);

// --- passphrase session (stateless, single-user) ---------------------------
// The cookie carries an HMAC of a fixed label keyed by the passphrase — proves
// the holder knew the passphrase, without storing the passphrase or a session.
function expectedSession(): string {
  return createHmac("sha256", DESK_PASSPHRASE).update("review-desk-session-v1").digest("base64url");
}
function ctEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function isAuthed(c: Context): boolean {
  if (!deskEnabled()) return false;
  const cookie = getCookie(c, COOKIE);
  return !!cookie && ctEqual(cookie, expectedSession());
}

// --- maw proxy -------------------------------------------------------------
function mawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${MAW_BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${MAW_REVIEW_DESK_SECRET}` },
  });
}

// guard: browser must be authed + maw must be configured
function guard(c: Context): Response | null {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  if (!mawConfigured()) return c.json({ error: "maw not configured" }, 503);
  return null;
}

export function registerReviewDesk(app: Hono, webDir: string) {
  const htmlRoot = relative(process.cwd(), webDir) || ".";
  const reviewHtml = serveStatic({ path: join(htmlRoot, "review.html") });

  // --- auth -------------------------------------------------------------
  app.post("/api/login", async (c) => {
    if (!deskEnabled()) return c.json({ error: "desk not configured" }, 503);
    let body: { passphrase?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    if (!body.passphrase || !ctEqual(body.passphrase, DESK_PASSPHRASE)) {
      return c.json({ error: "wrong passphrase" }, 401);
    }
    setCookie(c, COOKIE, expectedSession(), {
      httpOnly: true,
      sameSite: "Lax",
      secure: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return c.json({ ok: true });
  });

  app.post("/api/logout", (c) => {
    setCookie(c, COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return c.json({ ok: true });
  });

  app.get("/api/session", (c) =>
    c.json({ authed: isAuthed(c), deskEnabled: deskEnabled(), mawConfigured: mawConfigured() }),
  );

  // --- desk UI (passphrase gate is enforced at the API layer) -----------
  app.get("/review", reviewHtml);
  app.get("/r/:token", reviewHtml);

  // --- proxied maw review plane -----------------------------------------
  // GET /api/pending — snapshot of pending Rounds (catch-up).
  app.get("/api/pending", async (c) => {
    const blocked = guard(c);
    if (blocked) return blocked;
    try {
      const r = await mawFetch("/api/review/pending");
      return c.json(await r.json(), r.status as 200);
    } catch (e) {
      return c.json({ error: "maw unreachable: " + (e as Error).message }, 502);
    }
  });

  // GET /api/review/:token — full envelope + Round history.
  app.get("/api/review/:token", async (c) => {
    const blocked = guard(c);
    if (blocked) return blocked;
    try {
      const r = await mawFetch(`/api/review/${encodeURIComponent(c.req.param("token"))}`);
      return c.json(await r.json(), r.status as 200);
    } catch (e) {
      return c.json({ error: "maw unreachable: " + (e as Error).message }, 502);
    }
  });

  // POST /api/review/:token/decision — relay the Decision (+ opaque feedback).
  app.post("/api/review/:token/decision", async (c) => {
    const blocked = guard(c);
    if (blocked) return blocked;
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

  // GET /api/stream — relay the maw SSE stream to the browser + heartbeat.
  // Two hops (maw→backend, backend→browser); browsers can't set Authorization on
  // EventSource, so the backend holds the secret and forwards.
  app.get("/api/stream", async (c) => {
    const blocked = guard(c);
    if (blocked) return blocked;
    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => (aborted = true));

      let upstream: Response;
      try {
        upstream = await mawFetch("/api/review/stream", { headers: { accept: "text/event-stream" } });
      } catch (e) {
        await stream.writeSSE({ event: "error", data: String((e as Error).message) });
        return;
      }
      if (!upstream.ok || !upstream.body) {
        await stream.writeSSE({ event: "error", data: `maw stream ${upstream.status}` });
        return;
      }

      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      const HB = Symbol("hb");
      let pending = reader.read();
      try {
        while (!aborted) {
          const raced = await Promise.race([
            pending,
            new Promise((res) => setTimeout(() => res(HB), 20000)),
          ]);
          if (raced === HB) {
            await stream.write(": ping\n\n"); // SSE comment — keeps proxies from idling out
            continue; // `pending` is still in flight
          }
          const { done, value } = raced as ReadableStreamReadResult<Uint8Array>;
          if (done) break;
          await stream.write(dec.decode(value, { stream: true })); // forward raw SSE bytes
          pending = reader.read();
        }
      } catch {
        /* browser disconnected or upstream error */
      } finally {
        reader.cancel().catch(() => {});
      }
    });
  });
}
