// Shared multipart client. File.slice() keeps large files out of JS memory.
export async function uploadFile(file, { signal, onProgress = () => {}, fetch: fetcher = globalThis.fetch } = {}) {
  const id = crypto.randomUUID();
  const path = `/api/uploads/${id}`;
  try {
    const session = await send(fetcher, "POST", "/api/uploads", {
      json: { id, name: file.name, size: file.size, type: file.type || "application/octet-stream" }, signal,
    });
    if (session.status === "ready") return session.file;
    for (let number = 1; number <= session.partCount; number++) {
      const start = (number - 1) * session.partSize;
      const end = Math.min(file.size, start + session.partSize);
      onProgress({ loaded: start, total: file.size, part: number, parts: session.partCount });
      await send(fetcher, "PUT", `${path}/parts/${number}`, { body: file.slice(start, end), signal });
      onProgress({ loaded: end, total: file.size, part: number, parts: session.partCount });
    }
    return await send(fetcher, "POST", `${path}/complete`, { signal });
  } catch (error) {
    // Use a fresh timeout so cancelling the upload can still cancel its reservation.
    try {
      const status = await send(fetcher, "GET", path, { retries: 1, timeout: 15000 });
      if (status.status === "ready") return status.file;
    } catch { /* The session may not have been created. */ }
    try { await send(fetcher, "DELETE", path, { retries: 2, timeout: 15000 }); }
    catch { /* A persisted alarm cleans up unreachable or interrupted sessions. */ }
    throw error;
  }
}

async function send(fetcher, method, path, { json, body, signal, retries = 3, timeout = 600000 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Upload timed out.")), timeout);
    let retryable = true;
    try {
      const headers = {};
      if (json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(json);
      } else if (body) {
        headers["Content-Type"] = "application/octet-stream";
        headers["X-Part-Size"] = String(body.size);
      }
      const response = await fetcher(path, { method, headers, body, signal: controller.signal, cache: "no-store" });
      retryable = response.status === 429 || response.status >= 500;
      let data;
      try { data = await response.json(); }
      catch { throw new Error("Unexpected server response. Please try again."); }
      if (!response.ok) throw new Error(data.error || "Upload failed.");
      return data;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!retryable || attempt + 1 === retries) throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
  }
}
