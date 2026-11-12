import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

let mf, stub, bucket;
before(async () => {
  const source = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
  // Test-only RPC controls; none are included in the deployed Worker.
  const harness = `
export class TestBoard extends ClipboardBoard {
  async testExpire(kind) {
    if (kind === 'text') {
      const record = await this.ctx.storage.get('content');
      record.expiresAt = Date.now() - 1;
      await this.ctx.storage.put('content', record);
    } else {
      for (const file of await this.files()) {
        file.expiresAt = Date.now() - 1;
        delete file.retryAt;
        await this.ctx.storage.put('file:' + file.id, file);
      }
    }
  }
  async testCleanup() { await this.alarm(); }
  async testFiles() { return this.files(); }
  async testFailure(value) { await this.ctx.storage.put('test:failDelete', value); }
  async testPending() {
    const file = { id: crypto.randomUUID(), key: 'attachments/orphan', size: 3, status: 'uploading', expiresAt: Date.now() - 1 };
    await this.ctx.storage.put('file:' + file.id, file);
    await this.env.ATTACHMENTS.put(file.key, 'abc');
  }
  async testLegacyFile(expired = false) {
    const uploadedAt = Date.now() - (expired ? DAY + 1000 : 1000);
    const file = { id: crypto.randomUUID(), name: 'legacy.txt', size: 3, type: 'text/plain', uploadedAt, expiresAt: uploadedAt + DAY, status: 'ready' };
    file.key = 'attachments/' + file.id;
    await this.ctx.storage.put('file:' + file.id, file);
    await this.env.ATTACHMENTS.put(file.key, 'abc');
    this.retentionMigrated = false;
    return file;
  }
  async testQuota(size) {
    const files = await this.files();
    files[0].size = size;
    await this.ctx.storage.put('file:' + files[0].id, files[0]);
  }
}`;
  const faultInjected = source.replace('await this.env.ATTACHMENTS.delete(file.key);', `
    if (await this.ctx.storage.get('test:failDelete')) throw new Error('Simulated R2 failure');
    await this.env.ATTACHMENTS.delete(file.key);`);
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: faultInjected + harness,
    compatibilityDate: "2026-10-08", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { BOARD: { className: "TestBoard", useSQLite: true } },
    r2Buckets: ["ATTACHMENTS"], bindings: { BOARD_TTL_SECONDS: "86400" },
  }));
  const ns = await mf.getDurableObjectNamespace("BOARD");
  stub = ns.get(ns.idFromName("personal-whiteboard"));
  bucket = await mf.getR2Bucket("ATTACHMENTS");
});
after(async () => { await mf?.dispose(); });
const request = (path, init) => mf.dispatchFetch(`https://board.test${path}`, init);
async function write(text) {
  const response = await request("/api/board", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  assert.equal(response.status, 200);
  return response.json();
}
async function upload(name = "测试截图.png", body = "image bytes", type = "image/png") {
  return request("/api/files", { method: "POST", headers: { "X-File-Name": encodeURIComponent(name), "Content-Type": type }, body });
}
async function reset() {
  await stub.testFailure(false);
  await request("/api/board", { method: "DELETE" });
  await stub.testCleanup();
}

test("text saves for a full day; clients cannot override TTL", async () => {
  const record = await write("hello");
  assert.equal(record.expiresAt - record.updatedAt, 86_400_000);
  const response = await request("/api/board", { method: "PUT", headers: { "X-Board-TTL": "60" }, body: JSON.stringify({ text: "again" }) });
  const next = await response.json();
  assert.equal(next.expiresAt - next.updatedAt, 86_400_000);
});
test("validation and origin checks reject invalid requests", async () => {
  assert.equal((await request("/api/board", { method: "PUT", body: "{" })).status, 400);
  assert.equal((await request("/api/board", { method: "PUT", body: JSON.stringify({ text: "a".repeat(100_001) }) })).status, 413);
  assert.equal((await request("/api/files", { method: "POST", headers: { Origin: "https://other.test" }, body: "x" })).status, 403);
  assert.equal((await request("/api/files", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" }, body: "x" })).status, 403);
  assert.equal((await request("/api/board", { method: "POST" })).status, 405);
  assert.equal((await upload("empty", "")).status, 400);
  assert.equal((await upload("a".repeat(256))).status, 400);
  assert.equal((await upload("large", new Uint8Array(20 * 1024 * 1024 + 1))).status, 413);
});
test("upload, cross-device list, preview and download preserve original bytes", async () => {
  await reset();
  const response = await upload();
  assert.equal(response.status, 201);
  const file = await response.json();
  assert.equal(file.name, "测试截图.png");
  assert.equal(file.expiresAt - file.uploadedAt, 259_200_000);
  assert.equal(file.previewable, true);
  const board = await (await request("/api/board")).json();
  assert.equal(board.files[0].id, file.id);
  const preview = await request(`/api/files/${file.id}`);
  assert.equal(preview.headers.get("Content-Type"), "image/png");
  assert.equal(preview.headers.get("Cache-Control"), "private, no-store");
  assert.equal(await preview.text(), "image bytes");
  const download = await request(`/api/files/${file.id}?download`);
  assert.match(download.headers.get("Content-Disposition"), /^attachment;/);
  assert.match(download.headers.get("Content-Disposition"), /filename\*=UTF-8/);
  assert.equal(await download.text(), "image bytes");
  assert.equal((await request(`/api/files/${file.id}`, { method: "HEAD" })).status, 200);
});
test("active formats are downloads, never same-origin HTML or SVG previews", async () => {
  await reset();
  const file = await (await upload("test.svg", "<svg></svg>", "image/svg+xml")).json();
  assert.equal(file.previewable, false);
  const response = await request(`/api/files/${file.id}`);
  assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(response.headers.get("Content-Disposition"), /^attachment;/);
});
test("text edits and empty text do not extend or delete existing attachments", async () => {
  await reset();
  const file = await (await upload()).json();
  await write("new text");
  const board = await write("");
  assert.equal(board.text, "");
  assert.equal(board.files[0].expiresAt, file.expiresAt);
  await stub.testExpire("text");
  await stub.testCleanup();
  assert.equal((await (await request("/api/board")).json()).files.length, 1);
});
test("expired files are hidden and inaccessible before background deletion", async () => {
  await reset();
  const file = await (await upload()).json();
  await stub.testExpire("files");
  assert.equal((await request(`/api/files/${file.id}`)).status, 404);
  assert.equal((await (await request("/api/board")).json()).files.length, 0);
  assert.ok(await bucket.head(`attachments/${file.id}`));
  await stub.testCleanup();
  assert.equal(await bucket.head(`attachments/${file.id}`), null);
});
test("failed deletes stay hidden with durable retry metadata and can recover", async () => {
  await reset();
  const file = await (await upload()).json();
  await stub.testFailure(true);
  assert.equal((await request(`/api/files/${file.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await request(`/api/files/${file.id}`)).status, 404);
  const pending = await stub.testFiles();
  assert.equal(pending[0].status, "deleting");
  assert.ok(pending[0].retryAt > Date.now());
  assert.ok(await bucket.head(`attachments/${file.id}`));
  await stub.testFailure(false);
  await stub.testExpire("files");
  await stub.testCleanup();
  assert.equal(await bucket.head(`attachments/${file.id}`), null);
});
test("clear all removes text and R2 objects; interrupted uploads are cleaned", async () => {
  await reset();
  await write("text");
  const file = await (await upload("doc.pdf", "pdf", "application/pdf")).json();
  const board = await (await request("/api/board", { method: "DELETE" })).json();
  assert.equal(board.text, "");
  assert.deepEqual(board.files, []);
  assert.equal(await bucket.head(`attachments/${file.id}`), null);
  await stub.testPending();
  await stub.testCleanup();
  assert.equal(await bucket.head("attachments/orphan"), null);
});
test("server enforces both file count and total size quotas", async () => {
  await reset();
  const responses = await Promise.all(Array.from({ length: 21 }, (_, i) => upload(`${i}.txt`, "a", "text/plain")));
  assert.equal(responses.filter(response => response.status === 201).length, 20);
  assert.equal(responses.filter(response => response.status === 413).length, 1);
  await reset();
  await upload();
  await stub.testQuota(100 * 1024 * 1024);
  assert.equal((await upload()).status, 413);
  await reset();
});

test("a file exactly at the 20 MB boundary is accepted intact", async () => {
  await reset();
  const response = await upload("boundary.bin", new Uint8Array(20 * 1024 * 1024), "application/octet-stream");
  assert.equal(response.status, 201);
  const file = await response.json();
  assert.equal(file.size, 20 * 1024 * 1024);
  const stored = await bucket.head(`attachments/${file.id}`);
  assert.equal(stored.size, file.size);
  await reset();
});

test("live one-day attachments migrate to three days without restoring expired files", async () => {
  await reset();
  const live = await stub.testLegacyFile();
  const expired = await stub.testLegacyFile(true);
  const board = await (await request("/api/board")).json();
  assert.equal(board.files.length, 1);
  assert.equal(board.files[0].id, live.id);
  assert.equal(board.files[0].expiresAt, live.uploadedAt + 259_200_000);
  assert.equal((await request(`/api/files/${expired.id}`)).status, 404);
  await stub.testCleanup();
  assert.equal((await request(`/api/files/${live.id}`)).status, 200);
  await reset();
});
