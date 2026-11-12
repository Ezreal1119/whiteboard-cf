import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { uploadFile as uploadClient } from "../public/uploads.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let mf, stub, bucket;
let s3Failure = false;
const s3Uploads = new Map();
before(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/worker.js", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"] });
  const source = bundle.outputFiles[0].text;
  // Test-only RPC controls; none are included in the deployed Worker.
  const harness = `
export class TestBoard extends ClipboardBoard {
  async testConfig(enabled) { this.env.R2_ACCESS_KEY_ID = enabled ? 'test-access' : ''; }
  async testLeaseExpired(id) {
    const file = await this.ctx.storage.get('file:' + id);
    file.leaseUntil = Date.now() - 1;
    file.expiresAt = Date.now() - 1;
    delete file.retryAt;
    await this.ctx.storage.put('file:' + id, file);
  }
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
  async testAbortUnderlying(id) {
    const file = await this.ctx.storage.get('file:' + id);
    await this.env.ATTACHMENTS.resumeMultipartUpload(file.key, file.uploadId).abort();
  }
  async testLoseCompletion(id) {
    const file = await this.ctx.storage.get('file:' + id);
    file.status = 'completing';
    await this.ctx.storage.put('file:' + id, file);
    await this.env.ATTACHMENTS.resumeMultipartUpload(file.key, file.uploadId).complete(Object.values(file.parts).map(({partNumber, etag}) => ({partNumber, etag})));
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
    r2Buckets: ["ATTACHMENTS"], bindings: { BOARD_TTL_SECONDS: "86400", R2_S3_ENDPOINT: "https://test.r2.cloudflarestorage.com", R2_BUCKET_NAME: "whiteboard-attachments", R2_ACCESS_KEY_ID: "test-access", R2_SECRET_ACCESS_KEY: "test-secret" },
    outboundService: async request => {
      if (s3Failure) return new Response('Unavailable', {status:503});
      assert.match(request.headers.get('Authorization'), /^AWS4-HMAC-SHA256 /);
      const key = new URL(request.url).searchParams.get('prefix');
      const uploads = (s3Uploads.get(key) || []).map(id => `<Upload><Key>${key}</Key><UploadId>${id}</UploadId></Upload>`).join('');
      return new Response(`<ListMultipartUploadsResult><Bucket>whiteboard-attachments</Bucket><IsTruncated>false</IsTruncated>${uploads}</ListMultipartUploadsResult>`, {headers:{'Content-Type':'application/xml'}});
    },
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
  s3Failure = false;
  await stub.testFailure(false);
  // External test clients have exited before teardown.
  for (const file of await stub.testFiles()) if (file.mode === 'rclone') await stub.testLeaseExpired(file.id);
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
  assert.equal((await request(`/api/uploads/${crypto.randomUUID()}/parts/1`, {method:"PUT", headers:{"X-Part-Size":String(32*1024*1024+1)}, body:"x"})).status, 413);
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
test("filename URLs support curl remote naming and resume while legacy links stay valid", async () => {
  await reset();
  const body = "firmware bytes for curl resume";
  const file = await (await upload("firmware (2).apk", body, "application/octet-stream")).json();
  const downloadName = "firmware_2_.apk";
  assert.equal(file.name, "firmware (2).apk");
  assert.equal(file.downloadUrl, `/api/files/${file.id}/${downloadName}`);
  const head = await request(file.downloadUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Accept-Ranges"), "bytes");
  assert.equal(head.headers.get("Content-Length"), String(body.length));
  assert.equal((await request(`/api/files/${file.id}/wrong.apk`)).status, 404);
  assert.equal((await request(`/api/files/${file.id}/%ZZ`)).status, 400);
  assert.equal(await (await request(`/api/files/${file.id}?download`)).text(), body);
  const dir = await mkdtemp(join(tmpdir(), "wb-curl-"));
  try {
    const url = new URL(file.downloadUrl, await mf.ready).href;
    await promisify(execFile)("curl", ["--fail", "--silent", "--show-error", "--noproxy", "*", "-C", "-", "-O", url], { cwd: dir, timeout: 15000 });
    assert.equal(await readFile(join(dir, downloadName), "utf8"), body);
    await writeFile(join(dir, downloadName), body.slice(0, 5));
    await promisify(execFile)("curl", ["--fail", "--silent", "--show-error", "--noproxy", "*", "-C", "-", "-O", url], { cwd: dir, timeout: 15000 });
    assert.equal(await readFile(join(dir, downloadName), "utf8"), body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const image = await (await upload("测试 #1?.png")).json();
  assert.equal(image.downloadUrl, `/api/files/${image.id}/_1_.png`);
  const download = await request(image.downloadUrl);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("Content-Disposition"), /^attachment;/);
  assert.equal(await download.text(), "image bytes");
  await stub.testExpire("files");
  assert.equal((await request(image.downloadUrl)).status, 404);
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
  await stub.testQuota(20_000_000_000);
  assert.equal((await upload()).status, 413);
  await reset();
});

test("a legacy single-request file at the 32 MiB boundary is accepted intact", async () => {
  await reset();
  const response = await upload("boundary.bin", new Uint8Array(32 * 1024 * 1024), "application/octet-stream");
  assert.equal(response.status, 201);
  const file = await response.json();
  assert.equal(file.size, 32 * 1024 * 1024);
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

const PART = 32 * 1024 * 1024;
async function createUpload(size, name = "large.bin", id) {
  return request("/api/uploads", { method: "POST", body: JSON.stringify({ size, name, id, type: "application/octet-stream" }) });
}
async function part(id, number, body, size = body.byteLength ?? body.size ?? body.length) {
  return request(`/api/uploads/${id}/parts/${number}`, { method: "PUT", headers: { "X-Part-Size": String(size) }, body });
}
const boardState = async () => (await request("/api/board")).json();

test("3 GB upload boundaries, metadata validation, and idempotent reservation", async () => {
  await reset();
  assert.equal((await createUpload(3_000_000_001)).status, 413);
  assert.equal((await createUpload(0)).status, 413);
  assert.equal((await createUpload(1.5)).status, 413);
  assert.equal((await createUpload(1, "a".repeat(256))).status, 400);
  assert.equal((await request('/api/uploads', {method:'POST',body:'null'})).status, 400);
  const id = crypto.randomUUID();
  assert.equal((await createUpload(3_000_000_000, "large.bin", id)).status, 201);
  assert.equal((await createUpload(3_000_000_000, "large.bin", id)).status, 200);
  assert.equal((await createUpload(2, "different.bin", id)).status, 409);
  const board = await boardState();
  assert.equal(board.files.length, 0);
  assert.equal(board.storage.reservedBytes, 3_000_000_000);
  assert.equal(board.limits.totalBytes, 20_000_000_000);
  await reset();
});

test("simultaneous reservations never exceed 20 GB and cancellation releases space", async () => {
  await reset();
  const responses = await Promise.all(Array.from({ length: 8 }, () => createUpload(3_000_000_000)));
  assert.equal(responses.filter(response => response.status === 201).length, 6);
  assert.equal(responses.filter(response => response.status === 413).length, 2);
  assert.equal((await createUpload(2_000_000_000)).status, 201);
  assert.equal((await createUpload(1)).status, 413);
  assert.equal((await boardState()).storage.usedBytes, 20_000_000_000);
  const session = await responses.find(response => response.status === 201).json();
  assert.equal((await request(`/api/uploads/${session.id}`, {method:'DELETE'})).status, 200);
  assert.equal((await createUpload(3_000_000_000)).status, 201);
  await reset();
});

test("parts are bounded, validated, hidden until complete, and can be retried", async () => {
  await reset();
  const session = await (await createUpload(PART + 3)).json();
  assert.equal((await request(`/api/uploads/${session.id}/complete`, {method:'POST'})).status, 409);
  assert.equal((await part(session.id, 0, 'abc')).status, 404);
  assert.equal((await part(session.id, 3, 'abc')).status, 400);
  assert.equal((await part(session.id, 2, 'abcd')).status, 400);
  assert.equal((await part(session.id, 2, 'ab', 3)).status, 400);
  assert.equal((await part(session.id, 2, 'abcd', 3)).status, 400);
  assert.equal((await part(session.id, 1, new Uint8Array(PART))).status, 200);
  assert.equal((await part(session.id, 2, 'old')).status, 200);
  assert.equal((await part(session.id, 2, 'new')).status, 200);
  assert.equal((await boardState()).files.length, 0);
  assert.equal((await request(`/api/files/${session.id}`)).status, 404);
  const completed = await request(`/api/uploads/${session.id}/complete`, {method:'POST'});
  assert.equal(completed.status, 201);
  const file = await completed.json();
  assert.equal(file.size, PART + 3);
  assert.equal(file.expiresAt - file.uploadedAt, 259_200_000);
  assert.equal((await request(`/api/uploads/${session.id}/complete`, {method:'POST'})).status, 200);
  assert.equal((await request(`/api/uploads/${session.id}`, {method:'DELETE'})).status, 409);
  const download = await request(`/api/files/${session.id}`, {headers:{Range:`bytes=${PART}-`}});
  assert.equal(download.status, 206);
  assert.equal(download.headers.get('Content-Range'), `bytes ${PART}-${PART+2}/${PART+3}`);
  assert.equal(await download.text(), 'new');
  assert.equal((await boardState()).storage.reservedBytes, 0);
  assert.equal((await part(session.id, 2, 'bad')).status, 409);
  await reset();
});

test("multipart uploads are aborted on expiry and repeated aborts release reservations", async () => {
  await reset();
  const session = await (await createUpload(3)).json();
  await part(session.id, 1, 'abc');
  const [file] = await stub.testFiles();
  await stub.testExpire('files');
  await stub.testCleanup();
  assert.equal((await boardState()).storage.usedBytes, 0);
  await assert.rejects(() => bucket.resumeMultipartUpload(file.key, file.uploadId).uploadPart(1,'abc'));
  const another = await (await createUpload(3)).json();
  await stub.testAbortUnderlying(another.id);
  await request(`/api/uploads/${another.id}`, {method:'DELETE'});
  assert.equal((await boardState()).storage.usedBytes, 0);
});

test("completion recovers after R2 succeeds but metadata commit is interrupted", async () => {
  await reset();
  const session = await (await createUpload(3)).json();
  await part(session.id, 1, 'abc');
  await stub.testLoseCompletion(session.id);
  const response = await request(`/api/uploads/${session.id}/complete`, {method:'POST'});
  assert.equal(response.status, 201);
  assert.equal(await (await request(`/api/files/${session.id}`)).text(), 'abc');
  await reset();
});

test("shared browser uploader retries lost create/part responses without duplicate files", async () => {
  await reset();
  let lostCreate = false, lostPart = false;
  const file = new File([new Uint8Array(PART), 'tail'], 'browser-image.png', {type:'image/png'});
  const fetcher = async (path, options) => {
    const response = await request(path, options);
    if(path === '/api/uploads' && !lostCreate) { lostCreate=true; throw new Error('Lost create response'); }
    if(path.endsWith('/parts/1') && !lostPart) { lostPart=true; throw new Error('Lost part response'); }
    return response;
  };
  const result = await uploadClient(file, {fetch:fetcher});
  assert.equal(result.previewable, true);
  assert.equal((await boardState()).files.length, 1);
  const range = await request(`/api/files/${result.id}`, {headers:{Range:'bytes=-4'}});
  assert.equal(await range.text(), 'tail');
  await reset();
});

test("browser cancellation aborts the session and releases reserved capacity", async () => {
  await reset();
  const controller = new AbortController();
  await assert.rejects(() => uploadClient(new File(['abc'], 'cancel.txt'), {
    signal: controller.signal, fetch: request,
    onProgress() { controller.abort(new Error('Upload cancelled.')); },
  }), /cancelled/);
  assert.equal((await boardState()).storage.usedBytes, 0);
});

test("a file larger than 100 MB uploads and streams back with matching SHA-256", async () => {
  await reset();
  const size = 4 * PART + 17;
  const session = await (await createUpload(size)).json();
  const expected = createHash('sha256');
  for(let number=1;number<=session.partCount;number++) {
    const bytes = new Uint8Array(Math.min(PART, size-(number-1)*PART)).fill(number);
    expected.update(bytes);
    assert.equal((await part(session.id,number,bytes)).status,200);
  }
  assert.equal((await request(`/api/uploads/${session.id}/complete`,{method:'POST'})).status,201);
  const actual = createHash('sha256');
  const download = await request(`/api/files/${session.id}`);
  for await (const chunk of download.body) actual.update(chunk);
  assert.equal(actual.digest('hex'), expected.digest('hex'));
  await reset();
});

const STOP_TOKEN = '1'.repeat(64);
async function createRclone(size = 3) {
  return request('/api/uploads', {method:'POST',body:JSON.stringify({name:'rclone.bin',size,mode:'rclone',stopToken:STOP_TOKEN})});
}
function stoppedRequest(id, action, token = STOP_TOKEN) {
  return request(`/api/uploads/${id}/${action}`, {method:'POST', body:JSON.stringify({stopToken:token})});
}

test('rclone creation requires server credentials and returns no secrets or native multipart session', async () => {
  await reset();
  await stub.testConfig(false);
  assert.equal((await createRclone()).status,503);
  await stub.testConfig(true);
  const response=await createRclone(); assert.equal(response.status,201);
  const session=await response.json();
  assert.equal(session.mode,'rclone');
  assert.equal(session.bucket,'whiteboard-attachments');
  assert.equal(session.key,'attachments/'+session.id);
  const stored=(await stub.testFiles())[0];
  assert.equal(stored.uploadId,undefined);
  assert.equal(stored.stopToken,undefined);
  assert.equal(typeof stored.stopTokenHash,'string');
  const publicStatus=await(await request('/api/uploads/'+session.id)).json();
  assert.equal(publicStatus.stopTokenHash,undefined);
  assert.equal(publicStatus.stopToken,undefined);
  assert.equal((await part(session.id,1,'abc')).status,409);
  await reset();
});

test('rclone registers a directly uploaded object with three-day sharing and idempotent completion', async () => {
  await reset();
  const session=await(await createRclone()).json();
  assert.equal((await stoppedRequest(session.id,'complete','2'.repeat(64))).status,403);
  assert.equal((await stoppedRequest(session.id,'complete')).status,409);
  await bucket.put(session.key,'abc');
  const response=await stoppedRequest(session.id,'complete');assert.equal(response.status,201);
  const file=await response.json();assert.equal(file.size,3);
  assert.equal(file.expiresAt-file.uploadedAt,259200000);
  assert.equal((await boardState()).files.length,1);
  assert.equal(await(await request('/api/files/'+file.id)).text(),'abc');
  assert.equal((await stoppedRequest(session.id,'complete')).status,200);
  await reset();
});

test('rclone rejects mismatched objects and cleans them up on acknowledged cancellation', async () => {
  await reset();
  const session=await(await createRclone()).json();
  await bucket.put(session.key,'too large');
  assert.equal((await stoppedRequest(session.id,'complete')).status,409);
  assert.equal((await boardState()).files.length,0);
  assert.equal((await stoppedRequest(session.id,'cancel')).status,200);
  assert.equal(await bucket.head(session.key),null);
  assert.equal((await boardState()).storage.usedBytes,0);
});

test('board-side cancellation retains quota until the rclone client acknowledges it stopped', async () => {
  await reset();
  const session=await(await createRclone()).json();
  const unfinished=await bucket.createMultipartUpload(session.key);
  await unfinished.uploadPart(1,'abc');
  s3Uploads.set(session.key,[unfinished.uploadId]);
  const cancelled=await(await request('/api/uploads/'+session.id,{method:'DELETE'})).json();
  assert.equal(cancelled.cleanupPending,true);
  assert.equal((await boardState()).storage.usedBytes,3);
  assert.equal((await request('/api/uploads/'+session.id)).status,404);
  await assert.rejects(()=>unfinished.uploadPart(1,'abc'));
  assert.equal((await stoppedRequest(session.id,'cancel','2'.repeat(64))).status,403);
  const stopped=await(await stoppedRequest(session.id,'cancel')).json();
  assert.equal(stopped.cleanupPending,false);
  assert.equal((await boardState()).storage.usedBytes,0);
});

test('expired rclone sessions and failed S3 cleanup recover without leaking reserved space', async () => {
  await reset();
  const session=await(await createRclone()).json();
  s3Failure=true;
  const cancelled=await(await stoppedRequest(session.id,'cancel')).json();
  assert.equal(cancelled.cleanupPending,true);
  assert.equal((await boardState()).storage.usedBytes,3);
  s3Failure=false;
  await stub.testLeaseExpired(session.id);
  await stub.testCleanup();
  assert.equal((await boardState()).storage.usedBytes,0);
});
