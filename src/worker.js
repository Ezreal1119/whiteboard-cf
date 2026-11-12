import { DurableObject } from "cloudflare:workers";
import { abortRcloneParts, rcloneConfig, stopTokenHash } from "./rclone-storage.js";

const DAY = 86_400_000;
const FILE_RETENTION = 3 * DAY;
const MAX_TEXT_LENGTH = 100_000;
const MAX_FILE_SIZE = 3_000_000_000;
const PART_SIZE = 32 * 1024 * 1024;
const MAX_DIRECT_SIZE = PART_SIZE;
const UPLOAD_TTL = DAY;
const MAX_FILES = 20;
const MAX_TOTAL_SIZE = 20_000_000_000;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const FILE_PATH = new RegExp(`^/api/files/(${UUID})(?:/([^/]+))?$`);
const UPLOAD_PATH = new RegExp(`^/api/uploads/(${UUID})(?:/(complete|cancel|parts/[1-9][0-9]*))?$`);
const RETRY_DELAY = 60_000;
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/uploads/config" && request.method === "GET") return json({ rclone: rcloneConfig(env) });
    const isAPI = url.pathname === "/api/board" || url.pathname === "/api/files"
      || FILE_PATH.test(url.pathname)
      || url.pathname === "/api/uploads" || UPLOAD_PATH.test(url.pathname);
    if (isAPI) {
      if (!["GET", "HEAD"].includes(request.method)) {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) return json({ error: "Invalid request origin." }, 403);
        if (request.headers.get("Sec-Fetch-Site") === "cross-site") return json({ error: "Invalid request origin." }, 403);
      }
      const board = env.BOARD.get(env.BOARD.idFromName("personal-whiteboard"));
      const headers = new Headers(request.headers);
      headers.set("X-Board-TTL", String(env.BOARD_TTL_SECONDS || 86400));
      const isText = url.pathname === "/api/board" && request.method === "PUT";
      const isCreate = url.pathname === "/api/uploads" && request.method === "POST";
      const isControl = UPLOAD_PATH.test(url.pathname) && /\/(complete|cancel)$/.test(url.pathname) && request.method === "POST" && request.body;
      if (isText || isCreate || isControl) {
        const bytes = await readLimitedBody(request, isText ? 1_200_000 : 8192);
        if (bytes instanceof Response) return bytes;
        if (isControl && !bytes.byteLength) return board.fetch(new Request(request.url, { method: request.method, headers }));
        let body;
        try { body = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { return json({ error: "The request body must be valid JSON." }, 400); }
        if (isText && (!body || typeof body.text !== "string")) return json({ error: "A text value is required." }, 400);
        return board.fetch(new Request(request.url, { method: request.method, headers, body: JSON.stringify(body) }));
      }
      const isDirect = url.pathname === "/api/files" && request.method === "POST";
      const isPart = UPLOAD_PATH.test(url.pathname) && url.pathname.includes("/parts/") && request.method === "PUT";
      if (isDirect || isPart) {
        if (!env.ATTACHMENTS) return json({ error: "File storage is not configured." }, 503);
        const declared = request.headers.get(isDirect ? "Content-Length" : "X-Part-Size");
        if (declared === null || !/^\d+$/.test(declared)) return json({ error: isDirect ? "Content-Length is required. Use multipart uploads for large files." : "X-Part-Size is required." }, 411);
        const size = Number(declared);
        if (!Number.isSafeInteger(size) || size > PART_SIZE) return json({ error: "Each request is limited to 32 MiB. Use /api/uploads for large files." }, 413);
        if (size <= 0 || !request.body) return json({ error: "Empty files or parts cannot be uploaded." }, 400);
        if (isDirect) headers.set("X-File-Size", String(size));
        // Preserve backpressure all the way to R2; never buffer file bodies.
        return board.fetch(new Request(request.url, { method: request.method, headers, body: request.body }));
      }
      return board.fetch(new Request(request.url, { method: request.method, headers }));
    }
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Not found", { status: 404 });
    if (["/", "/index.html", "/app.js", "/uploads.js", "/styles.css", "/favicon.svg"].includes(url.pathname)) return env.ASSETS.fetch(request);
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
      if (url.pathname === "/api/uploads") {
        if (request.method === "POST") return this.createUpload(request);
        return json({ error: "Method not allowed." }, 405, { Allow: "POST" });
      }
      const uploadMatch = url.pathname.match(UPLOAD_PATH);
      if (uploadMatch) {
        const [, uploadId, action] = uploadMatch;
        if (!action && request.method === "GET") return this.uploadStatus(uploadId);
        if (!action && request.method === "DELETE") return this.abortUpload(uploadId);
        if (action === "complete" && request.method === "POST") return this.completeUpload(uploadId, request);
        if (action === "cancel" && request.method === "POST") return this.abortUpload(uploadId, request);
        if (action?.startsWith("parts/") && request.method === "PUT") return this.uploadPart(uploadId, Number(action.slice(6)), request);
        return json({ error: "Method not allowed." }, 405);
      }
      const fileMatch = url.pathname.match(FILE_PATH);
      if (!fileMatch) return json({ error: "Not found." }, 404);
      const [, id, filename] = fileMatch;
      if (["GET", "HEAD"].includes(request.method)) return this.download(id, request, Boolean(filename) || url.searchParams.has("download"), filename);
      if (request.method === "DELETE" && !filename) return this.remove(id);
      return json({ error: "Method not allowed." }, 405, { Allow: "GET, HEAD, DELETE" });
    }).catch(error => {
      if (!(error instanceof BodySizeError)) console.error("Board request failed", error);
      return json({ error: error instanceof BodySizeError ? "Request body size does not match the declared size." : "Storage is temporarily unavailable. Please retry." }, error instanceof BodySizeError ? 400 : 503);
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
    const records = await this.files();
    const files = records.filter(file => file.status === "ready" && file.expiresAt > now).map(publicFile);
    return {
      ...(record && record.expiresAt > now ? record : emptyBoard()), files,
      limits: { fileBytes: MAX_FILE_SIZE, totalBytes: MAX_TOTAL_SIZE, fileCount: MAX_FILES, partBytes: PART_SIZE, directBytes: MAX_DIRECT_SIZE },
      storage: {
        usedBytes: records.reduce((sum, file) => sum + file.size, 0),
        reservedBytes: records.filter(file => file.status !== "ready").reduce((sum, file) => sum + file.size, 0),
      },
    };
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

  validateFile(name, size, type) {
    if (typeof name !== "string") return json({ error: "A file name is required." }, 400);
    name = name.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!name || name.length > 255) return json({ error: "File names must be between 1 and 255 characters." }, 400);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_SIZE) return json({ error: "Files must be between 1 byte and 3 GB." }, 413);
    type = typeof type === "string" ? type.split(";")[0].toLowerCase() : "application/octet-stream";
    if (type.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) type = "application/octet-stream";
    return { name, size, type };
  }

  async reserveFile(metadata, id = crypto.randomUUID()) {
    await this.cleanup();
    const files = await this.files();
    if (files.length >= MAX_FILES || files.reduce((sum, file) => sum + file.size, 0) + metadata.size > MAX_TOTAL_SIZE) {
      return json({ error: "The board can hold 20 files and 20 GB in total, including uploads in progress. Remove a file or cancel an upload first." }, 413);
    }
    const file = { ...metadata, id, key: `attachments/${id}`, uploadedAt: 0, createdAt: Date.now(), expiresAt: Date.now() + UPLOAD_TTL, status: "creating" };
    await this.ctx.storage.put(`file:${id}`, file);
    await this.schedule();
    return file;
  }

  async finishFile(file, object) {
    if (object.size !== file.size) throw new Error("Stored file size mismatch");
    file.status = "ready";
    file.uploadedAt = object.uploaded.getTime();
    file.expiresAt = file.uploadedAt + FILE_RETENTION;
    delete file.uploadId;
    delete file.parts;
    await this.ctx.storage.put(`file:${file.id}`, file);
    await this.schedule();
    return json(publicFile(file), 201);
  }

  async upload(request) {
    if (!this.env.ATTACHMENTS) return json({ error: "File storage is not configured." }, 503);
    let name;
    try { name = decodeURIComponent(request.headers.get("X-File-Name") || ""); }
    catch { return json({ error: "Invalid file name." }, 400); }
    const size = Number(request.headers.get("X-File-Size"));
    if (size > MAX_DIRECT_SIZE) return json({ error: "Use multipart uploads for files larger than 32 MiB." }, 413);
    const metadata = this.validateFile(name, size, request.headers.get("Content-Type"));
    if (metadata instanceof Response) return metadata;
    const file = await this.reserveFile(metadata);
    if (file instanceof Response) return file;
    try {
      const object = await streamToR2(request, size, stream => this.env.ATTACHMENTS.put(file.key, stream, { httpMetadata: { contentType: file.type } }));
      return await this.finishFile(file, object);
    } catch (error) {
      await this.deleteFile(file);
      await this.schedule();
      throw error;
    }
  }

  session(file) {
    if (file.mode === "rclone") return { id: file.id, mode: "rclone", status: file.status, size: file.size, expiresAt: file.expiresAt, bucket: rcloneConfig(this.env).bucket, key: file.key, ...(file.status === "ready" ? { file: publicFile(file) } : {}) };
    return { id: file.id, status: file.status, size: file.size, partSize: PART_SIZE, partCount: Math.ceil(file.size / PART_SIZE), expiresAt: file.expiresAt, uploadedParts: Object.values(file.parts || {}).map(part => part.partNumber), ...(file.status === "ready" ? { file: publicFile(file) } : {}) };
  }

  async createUpload(request) {
    if (!this.env.ATTACHMENTS) return json({ error: "File storage is not configured." }, 503);
    const body = await request.json();
    if (!body || typeof body !== "object") return json({ error: "File metadata is required." }, 400);
    const metadata = this.validateFile(body.name, body.size, body.type);
    if (metadata instanceof Response) return metadata;
    const mode = body.mode || "multipart";
    if (!["multipart", "rclone"].includes(mode)) return json({ error: "Invalid upload mode." }, 400);
    if (mode === "rclone" && !rcloneConfig(this.env).configured) return json({ error: "Rclone uploads are not configured. Run patrick wb --setup first." }, 503);
    if (mode === "rclone" && (typeof body.stopToken !== "string" || !/^[a-f0-9]{64}$/.test(body.stopToken))) return json({ error: "A private upload stop token is required." }, 400);
    const tokenHash = mode === "rclone" ? await stopTokenHash(body.stopToken) : undefined;
    const id = body.id || crypto.randomUUID();
    if (typeof id !== "string" || !new RegExp(`^${UUID}$`).test(id)) return json({ error: "Invalid upload ID." }, 400);
    const existing = await this.ctx.storage.get(`file:${id}`);
    if (existing) {
      if (existing.name !== metadata.name || existing.size !== metadata.size || existing.type !== metadata.type || (existing.mode || "multipart") !== mode || (mode === "rclone" && existing.status !== "ready" && existing.stopTokenHash !== tokenHash)) return json({ error: "This upload ID is already in use." }, 409);
      if (!["uploading", "ready"].includes(existing.status) || existing.expiresAt <= Date.now()) return json({ error: "Upload is unavailable. Start a new upload." }, 409);
      return json(this.session(existing));
    }
    const file = await this.reserveFile(mode === "rclone" ? { ...metadata, mode, stopTokenHash: tokenHash, leaseUntil: Date.now() + UPLOAD_TTL } : metadata, id);
    if (file instanceof Response) return file;
    if (mode === "rclone") {
      file.status = "uploading";
      await this.ctx.storage.put(`file:${id}`, file);
      return json(this.session(file), 201);
    }
    try {
      const upload = await this.env.ATTACHMENTS.createMultipartUpload(file.key, { httpMetadata: { contentType: file.type } });
      file.uploadId = upload.uploadId;
      file.parts = {};
      file.status = "uploading";
      await this.ctx.storage.put(`file:${id}`, file);
      return json(this.session(file), 201);
    } catch (error) {
      await this.deleteFile(file);
      await this.schedule();
      throw error;
    }
  }

  async uploadStatus(id) {
    const file = await this.ctx.storage.get(`file:${id}`);
    if (!file || file.status === "deleting" || file.expiresAt <= Date.now()) return json({ error: "Upload not found or expired." }, 404);
    return json(this.session(file));
  }

  async uploadPart(id, partNumber, request) {
    const file = await this.ctx.storage.get(`file:${id}`);
    if (!file || file.mode === "rclone" || file.status !== "uploading" || file.expiresAt <= Date.now()) return json({ error: "Upload is unavailable or expired." }, 409);
    const count = Math.ceil(file.size / PART_SIZE);
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > count) return json({ error: "Invalid part number." }, 400);
    const size = Math.min(PART_SIZE, file.size - (partNumber - 1) * PART_SIZE);
    if (Number(request.headers.get("X-Part-Size")) !== size) return json({ error: `This part must contain exactly ${size} bytes.` }, 400);
    const upload = this.env.ATTACHMENTS.resumeMultipartUpload(file.key, file.uploadId);
    const part = await streamToR2(request, size, stream => upload.uploadPart(partNumber, stream));
    file.parts[partNumber] = { ...part, size };
    await this.ctx.storage.put(`file:${id}`, file);
    return json({ partNumber: part.partNumber, etag: part.etag, size });
  }

  async completeUpload(id, request) {
    const file = await this.ctx.storage.get(`file:${id}`);
    if (!file || file.status === "deleting" || file.expiresAt <= Date.now()) return json({ error: "Upload is unavailable or expired." }, 409);
    if (file.status === "ready") return json(publicFile(file));
    if (file.mode === "rclone") {
      if (!await this.validStopToken(file, request)) return json({ error: "Invalid upload stop token." }, 403);
      // Only the uploader can acknowledge that rclone has exited. Until then,
      // cancellation retains quota and keeps sweeping the key for late writes.
      file.rcloneStopped = true;
      file.status = "completing";
      await this.ctx.storage.put(`file:${id}`, file);
      const object = await this.env.ATTACHMENTS.head(file.key);
      if (!object) return json({ error: "Rclone has not uploaded this file yet." }, 409);
      if (object.size !== file.size || object.uploaded.getTime() < file.createdAt - 1000) return json({ error: "Uploaded object does not match its reservation." }, 409);
      if (!await abortRcloneParts(this.env, file.key)) return json({ error: "Multipart cleanup is still in progress. Please retry." }, 503);
      delete file.leaseUntil;
      delete file.stopTokenHash;
      return this.finishFile(file, object);
    }
    // A lost completion response or process restart must not strand a complete
    // R2 object. R2's object timestamp keeps retries from extending retention.
    if (file.status === "completing") {
      const object = await this.env.ATTACHMENTS.head(file.key);
      if (object) return this.finishFile(file, object);
    }
    if (!["uploading", "completing"].includes(file.status)) return json({ error: "Upload is not ready to complete." }, 409);
    const count = Math.ceil(file.size / PART_SIZE);
    const parts = Array.from({ length: count }, (_, index) => file.parts[index + 1]);
    if (parts.some(part => !part) || parts.reduce((sum, part) => sum + part.size, 0) !== file.size) return json({ error: "Upload all parts before completing the file." }, 409);
    file.status = "completing";
    await this.ctx.storage.put(`file:${id}`, file);
    const upload = this.env.ATTACHMENTS.resumeMultipartUpload(file.key, file.uploadId);
    const object = await upload.complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
    return this.finishFile(file, object);
  }

  async validStopToken(file, request) {
    if (!request?.body) return false;
    let body;
    try { body = await request.json(); } catch { return false; }
    return typeof body?.stopToken === "string" && /^[a-f0-9]{64}$/.test(body.stopToken) && await stopTokenHash(body.stopToken) === file.stopTokenHash;
  }

  async abortUpload(id, request) {
    const file = await this.ctx.storage.get(`file:${id}`);
    if (file?.status === "ready") return json({ error: "This upload is already complete. Delete the shared file instead." }, 409);
    if (file?.mode === "rclone" && request) {
      if (!await this.validStopToken(file, request)) return json({ error: "Invalid upload stop token." }, 403);
      file.rcloneStopped = true;
    }
    const deleted = !file || await this.deleteFile(file);
    await this.schedule();
    return json({ cancelled: true, cleanupPending: !deleted });
  }

  async download(id, request, forceDownload, filename) {
    const file = await this.ctx.storage.get(`file:${id}`);
    if (!file || file.status !== "ready" || file.expiresAt <= Date.now()) return json({ error: "File not found or expired." }, 404);
    if (filename !== undefined) {
      let decoded;
      try { decoded = decodeURIComponent(filename); }
      catch { return json({ error: "Invalid file name." }, 400); }
      if (decoded !== downloadName(file.name)) return json({ error: "File not found." }, 404);
    }
    const range = request.method === "GET" ? parseRange(request.headers.get("Range"), file.size) : null;
    if (range === false) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}`, "Cache-Control": "no-store" } });
    const object = request.method === "HEAD" ? await this.env.ATTACHMENTS.head(file.key) : await this.env.ATTACHMENTS.get(file.key, range ? { range } : undefined);
    if (!object) return json({ error: "File not found or expired." }, 404);
    // Recheck after the R2 round trip; never start serving an expired object.
    if (file.expiresAt <= Date.now()) return json({ error: "File not found or expired." }, 404);
    const inline = !forceDownload && INLINE_TYPES.has(file.type);
    return new Response(request.method === "HEAD" ? null : object.body, {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": inline ? file.type : "application/octet-stream",
        "Content-Length": String(range ? range.length : object.size),
        "Accept-Ranges": "bytes",
        "ETag": object.httpEtag,
        ...(range ? { "Content-Range": `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}` } : {}),
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
      let keepReservation = false;
      if (file.mode === "rclone" && file.leaseUntil) {
        if (!await abortRcloneParts(this.env, file.key)) return false;
        keepReservation = !file.rcloneStopped && file.leaseUntil > Date.now();
      }
      if (file.uploadId) {
        try {
          await this.env.ATTACHMENTS.resumeMultipartUpload(file.key, file.uploadId).abort();
        } catch (error) {
          // Lifecycle cleanup may already have removed this multipart session.
          if (!/NoSuchUpload|\(10024\)$/.test(String(error?.message))) throw error;
        }
      }
      await this.env.ATTACHMENTS.delete(file.key);
      if (keepReservation) return false;
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

function downloadName(name) {
  // A URL-safe ASCII name also works literally with curl -O, without decoding.
  const filename = name.replace(/[^A-Za-z0-9._-]+/g, "_");
  return filename === "." || filename === ".." || !filename ? "download" : filename;
}

function publicFile({ id, name, size, type, uploadedAt, expiresAt }) {
  const filename = downloadName(name);
  return { id, name, size, type, uploadedAt, expiresAt, previewable: INLINE_TYPES.has(type), downloadUrl: `/api/files/${id}/${filename}` };
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

class BodySizeError extends Error {}

async function streamToR2(request, size, operation) {
  if (!request.body) throw new BodySizeError();
  const stream = new FixedLengthStream(size);
  const controller = new AbortController();
  let bodyError;
  let aborting = false;
  const pump = request.body.pipeTo(stream.writable, { signal: controller.signal }).catch(error => {
    if (!aborting) bodyError = error;
    throw error;
  });
  pump.catch(() => {});
  try {
    const result = await operation(stream.readable);
    await pump;
    return result;
  } catch (error) {
    aborting = true;
    controller.abort();
    await pump.catch(() => {});
    if (bodyError || /FixedLengthStream/.test(String(error?.message))) throw new BodySizeError();
    throw error;
  }
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
  return { offset: start, length: end - start + 1 };
}
