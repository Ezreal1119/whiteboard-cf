import { DurableObject } from "cloudflare:workers";

const MAX_TEXT_LENGTH = 100_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const apiPath = "/api/board";

    if (url.pathname === apiPath) {
      if (!['GET', 'PUT', 'DELETE'].includes(request.method)) {
        return json({ error: "Method not allowed." }, 405, { Allow: "GET, PUT, DELETE" });
      }
      if (request.method !== "GET") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) return json({ error: "Invalid request origin." }, 403);
      }

      const id = env.BOARD.idFromName("personal-whiteboard");
      const board = env.BOARD.get(id);
      const headers = new Headers({ "Content-Type": "application/json" });
      if (request.method === "PUT") {
        const body = await readBody(request);
        if (body instanceof Response) return body;
        headers.set("X-Board-TTL", String(env.BOARD_TTL_SECONDS || 600));
        return board.fetch("https://board.internal/content", {
          method: "PUT",
          headers,
          body: JSON.stringify(body),
        });
      }
      return board.fetch("https://board.internal/content", {
        method: request.method,
        headers,
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return env.ASSETS.fetch(request);
    }
    if (["/app.js", "/styles.css", "/favicon.svg"].includes(url.pathname)) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
};

export class ClipboardBoard extends DurableObject {
  async fetch(request) {
    if (request.method === "GET") return this.read();
    if (request.method === "PUT") return this.write(request);
    if (request.method === "DELETE") return this.clear();
    return json({ error: "Method not allowed." }, 405);
  }

  async read() {
    const record = await this.ctx.storage.get("content");
    if (!record || record.expiresAt <= Date.now()) {
      if (record) await this.ctx.storage.delete("content");
      return json(emptyBoard());
    }
    return json(record);
  }

  async write(request) {
    const body = await request.json();
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length > MAX_TEXT_LENGTH) {
      return json({ error: "Text must be 100,000 characters or fewer." }, 413);
    }
    if (!text) return this.clear();

    const updatedAt = Date.now();
    const ttlSeconds = clamp(Number(request.headers.get("X-Board-TTL") || 600), 60, 3600);
    const record = {
      text,
      updatedAt,
      expiresAt: updatedAt + ttlSeconds * 1000,
    };
    await this.ctx.storage.put("content", record);
    await this.ctx.storage.setAlarm(record.expiresAt);
    return json(record);
  }

  async clear() {
    await this.ctx.storage.delete("content");
    await this.ctx.storage.deleteAlarm();
    return json(emptyBoard());
  }

  async alarm() {
    const record = await this.ctx.storage.get("content");
    if (!record || record.expiresAt <= Date.now()) {
      await this.ctx.storage.delete("content");
      return;
    }
    await this.ctx.storage.setAlarm(record.expiresAt);
  }
}

async function readBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The request body must be valid JSON." }, 400);
  }
  if (!body || typeof body.text !== "string") {
    return json({ error: "A text value is required." }, 400);
  }
  if (body.text.length > MAX_TEXT_LENGTH) {
    return json({ error: "Text must be 100,000 characters or fewer." }, 413);
  }
  return { text: body.text };
}

function emptyBoard() {
  return { text: "", updatedAt: 0, expiresAt: 0 };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
