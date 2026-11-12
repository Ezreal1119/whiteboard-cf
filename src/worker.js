import { DurableObject } from "cloudflare:workers";

const DAY = 86_400_000;
const FILE_RETENTION = 3 * DAY;
const MAX_TEXT_LENGTH = 100_000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
const RETRY_DELAY = 60_000;
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/board" || url.pathname === "/api/files" || /^\/api\/files\/[a-f0-9-]{36}$/.test(url.pathname)) {
      if (!["GET", "HEAD"].includes(request.method)) {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) return json({ error: "Invalid request origin." }, 403);
        if (request.headers.get("Sec-Fetch-Site") === "cross-site") return json({ error: "Invalid request origin." }, 403);
      }
      const board = env.BOARD.get(env.BOARD.idFromName("personal-whiteboard"));
      // Forward only trusted TTL configuration, never a client-supplied value.
      const headers = new Headers(request.headers);
      headers.set("X-Board-TTL", String(env.BOARD_TTL_SECONDS || 86400));
      if (url.pathname === "/api/board" && request.method === "PUT") {
        const bytes = await readLimitedBody(request, 1_200_000);
        if (bytes instanceof Response) return bytes;
        let body;
        try { body = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { return json({ error: "The request body must be valid JSON." }, 400); }
        if (!body || typeof body.text !== "string") return json({ error: "A text value is required." }, 400);
        if (body.text.length > MAX_TEXT_LENGTH) return json({ error: "Text must be 100,000 characters or fewer." }, 413);
        return board.fetch(new Request(request.url, { method: "PUT", headers, body: JSON.stringify({ text: body.text }) }));
      }
      if (url.pathname === "/api/files" && request.method === "POST") {
        if (!env.ATTACHMENTS) return json({ error: "File storage is not configured." }, 503);
        const bytes = await readLimitedBody(request, MAX_FILE_SIZE);
        if (bytes instanceof Response) return bytes;
        if (!bytes.byteLength) return json({ error: "Empty files cannot be uploaded." }, 400);
        headers.set("X-File-Size", String(bytes.byteLength));
        return board.fetch(new Request(request.url, { method: "POST", headers, body: bytes }));
      }
      return board.fetch(new Request(request.url, { method: request.method, headers }));
    }
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Not found", { status: 404 });
    if (["/", "/index.html", "/app.js", "/styles.css", "/favicon.svg"].includes(url.pathname)) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  },
};

export class ClipboardBoard extends DurableObject {
  // Serialize metadata + R2 operations, including alarms. Storage transactions alone
  // cannot protect the external R2 writes from a concurrent clear or expiry.
  queue = Promise.resolve();
  retentionMigrated = false;

  exclusive(operation) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  fetch(request) {
    return this.exclusive(async () => {
      await this.migrateFileRetention();
      const url = new URL(request.url);
      if (url.pathname === "/api/board") {
        if (request.method === "GET") return json(await this.snapshot());
        if (request.method === "PUT") return this.write(request);
        if (request.method === "DELETE") return this.clear();
        return json({ error: "Method not allowed." }, 405, { Allow: "GET, PUT, DELETE" });
      }
      if (url.pathname === "/api/files") {
        if (request.method === "POST") return this.upload(request);
        return json({ error: "Method not allowed." }, 405, { Allow: "POST" });
      }
      const id = url.pathname.split("/").pop();
      if (["GET", "HEAD"].includes(request.method)) return this.download(id, request, url.searchParams.has("download"));
      if (request.method === "DELETE") return this.remove(id);
      return json({ error: "Method not allowed." }, 405, { Allow: "GET, HEAD, DELETE" });
    });
  }

  async migrateFileRetention() {
    if (this.retentionMigrated) return;
    const now = Date.now();
    let changed = false;
    for (const file of await this.files()) {
      // Extend only live files saved under the previous one-day policy.
      // Deleted, expired and unfinished files must never be restored.
      if (file.status === "ready" && file.expiresAt > now && file.expiresAt === file.uploadedAt + DAY) {
        file.expiresAt = file.uploadedAt + FILE_RETENTION;
        await this.ctx.storage.put(`file:${file.id}`, file);
        changed = true;
      }
    }
    if (changed) await this.schedule();
    this.retentionMigrated = true;
  }

  async files() {
    return [...(await this.ctx.storage.list({ prefix: "file:" })).values()];
  }

  async snapshot() {
    const record = await this.ctx.storage.get("content");
    const now = Date.now();
    const files = (await this.files()).filter(file => file.status === "ready" && file.expiresAt > now).map(publicFile);
    return { ...(record && record.expiresAt > now ? record : emptyBoard()), files };
  }

  async schedule() {
    const record = await this.ctx.storage.get("content");
    const times = (await this.files()).map(file => file.retryAt || file.expiresAt);
    if (record?.expiresAt) times.push(record.expiresAt);
    if (times.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...times)));
    else await this.ctx.storage.deleteAlarm();
  }

  async write(request) {
    const { text } = await request.json();
    if (typeof text !== "string") return json({ error: "A text value is required." }, 400);
    if (text.length > MAX_TEXT_LENGTH) return json({ error: "Text must be 100,000 characters or fewer." }, 413);
    const updatedAt = Date.now();
    const configured = Number(request.headers.get("X-Board-TTL"));
    const ttl = Number.isFinite(configured) && configured > 0 ? Math.min(86400, Math.max(60, configured)) * 1000 : DAY;
    // Keep a tombstone so other devices accept text deletion as a newer edit.
    await this.ctx.storage.put("content", { text, updatedAt, expiresAt: updatedAt + ttl });
    await this.schedule();
    return json(await this.snapshot());
  }

  async upload(request) {
    if (!this.env.ATTACHMENTS) return json({ error: "File storage is not configured." }, 503);
    let name;
    try { name = decodeURIComponent(request.headers.get("X-File-Name") || ""); }
    catch { return json({ error: "Invalid file name." }, 400); }
    name = name.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!name || name.length > 255) return json({ error: "File names must be between 1 and 255 characters." }, 400);
    const size = Number(request.headers.get("X-File-Size"));
    if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_SIZE) return json({ error: "Files must be between 1 byte and 20 MB." }, 413);
    await this.cleanup();
    const files = await this.files();
    if (files.length >= MAX_FILES || files.reduce((sum, file) => sum + file.size, 0) + size > MAX_TOTAL_SIZE) {
      return json({ error: "The board can hold 20 files and 100 MB in total. Remove a file first." }, 413);
    }
    const id = crypto.randomUUID();
    const type = (request.headers.get("Content-Type") || "application/octet-stream").split(";")[0].toLowerCase();
    const file = { id, key: `attachments/${id}`, name, size, type, uploadedAt: Date.now(), expiresAt: Date.now() + FILE_RETENTION, status: "uploading" };
    // Persist the object key and schedule cleanup before writing to R2 so crashes
    // never leave an untracked object. Pending uploads are never downloadable.
    await this.ctx.storage.put(`file:${id}`, file);
    await this.schedule();
    try {
      await this.env.ATTACHMENTS.put(file.key, request.body, { httpMetadata: { contentType: type } });
      file.status = "ready";
      file.uploadedAt = Date.now();
      file.expiresAt = file.uploadedAt + FILE_RETENTION;
      await this.ctx.storage.put(`file:${id}`, file);
      await this.schedule();
      return json(publicFile(file), 201);
    } catch (error) {
      file.status = "deleting";
      file.expiresAt = Date.now();
      await this.ctx.storage.put(`file:${id}`, file);
      await this.schedule();
      console.error("Attachment upload failed", error);
      return json({ error: "Upload failed. Please try again." }, 503);
    }
  }

  async download(id, request, forceDownload) {
    const file = await this.ctx.storage.get(`file:${id}`);
    if (!file || file.status !== "ready" || file.expiresAt <= Date.now()) return json({ error: "File not found or expired." }, 404);
    const object = await this.env.ATTACHMENTS.get(file.key);
    if (!object) return json({ error: "File not found or expired." }, 404);
    // Recheck after the R2 round trip; never start serving an expired object.
    if (file.expiresAt <= Date.now()) return json({ error: "File not found or expired." }, 404);
    const inline = !forceDownload && INLINE_TYPES.has(file.type);
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: {
        "Content-Type": inline ? file.type : "application/octet-stream",
        "Content-Length": String(object.size),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16)}`)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }

  async deleteFile(file) {
    // Hide first, then delete R2, then delete metadata. Failed cleanup stays durable.
    file.status = "deleting";
    file.expiresAt = Math.min(file.expiresAt, Date.now());
    file.retryAt = Date.now() + RETRY_DELAY;
    await this.ctx.storage.put(`file:${file.id}`, file);
    await this.schedule();
    try {
      await this.env.ATTACHMENTS.delete(file.key);
      await this.ctx.storage.delete(`file:${file.id}`);
      return true;
    } catch (error) {
      console.error("Attachment cleanup will retry", error);
      return false;
    }
  }

  async remove(id) {
    const file = await this.ctx.storage.get(`file:${id}`);
    if (file) await this.deleteFile(file);
    await this.schedule();
    return json(await this.snapshot());
  }

  async clear() {
    await this.ctx.storage.put("content", { text: "", updatedAt: Date.now(), expiresAt: Date.now() + DAY });
    // Mark every attachment inaccessible before any external delete can fail.
    const files = await this.files();
    for (const file of files) {
      file.status = "deleting";
      file.expiresAt = Date.now();
      await this.ctx.storage.put(`file:${file.id}`, file);
    }
    await this.schedule();
    for (const file of files) await this.deleteFile(file);
    await this.schedule();
    return json(await this.snapshot());
  }

  async cleanup() {
    const now = Date.now();
    const record = await this.ctx.storage.get("content");
    if (record && record.expiresAt <= now) await this.ctx.storage.delete("content");
    for (const file of await this.files()) {
      if ((file.retryAt || file.expiresAt) <= now) await this.deleteFile(file);
    }
    await this.schedule();
  }

  alarm() {
    return this.exclusive(async () => {
      await this.migrateFileRetention();
      await this.cleanup();
    });
  }
}

function publicFile({ id, name, size, type, uploadedAt, expiresAt }) {
  return { id, name, size, type, uploadedAt, expiresAt, previewable: INLINE_TYPES.has(type) };
}

function emptyBoard() {
  return { text: "", updatedAt: 0, expiresAt: 0 };
}

async function readLimitedBody(request, limit) {
  if (Number(request.headers.get("Content-Length")) > limit) return json({ error: "The upload is too large." }, 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return json({ error: "The upload is too large." }, 413);
      }
      chunks.push(value);
    }
  } catch {
    return json({ error: "The upload was interrupted. Please try again." }, 400);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...extraHeaders } });
}
