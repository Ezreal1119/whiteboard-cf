import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";

export function rcloneConfig(env) {
  return {
    configured: Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_S3_ENDPOINT && env.R2_BUCKET_NAME),
    bucket: env.R2_BUCKET_NAME || "whiteboard-attachments",
    endpoint: env.R2_S3_ENDPOINT || "",
  };
}

// Rclone owns its multipart IDs. List only this reserved object's key and abort
// leftover uploads before deleting the object or releasing its reservation.
export async function abortRcloneParts(env, key) {
  if (!rcloneConfig(env).configured) throw new Error("Rclone storage credentials are not configured");
  const aws = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto", retries: 0 });
  const parser = new XMLParser({ parseTagValue: false, isArray: name => name === "Upload" });
  const url = new URL(`${env.R2_S3_ENDPOINT.replace(/\/$/, "")}/${encodeURIComponent(env.R2_BUCKET_NAME)}`);
  url.searchParams.set("uploads", "");
  url.searchParams.set("prefix", key);
  url.searchParams.set("max-uploads", "10");
  // Bound each alarm's network operations; retain quota and retry if more remain.
  for (let page = 0; page < 2; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let xml;
    try {
      const signed = await aws.sign(url, { method: "GET" });
      const response = await fetch(signed, { signal: controller.signal });
      if (!response.ok) throw new Error(`R2 multipart listing failed (${response.status})`);
      xml = parser.parse(await response.text()).ListMultipartUploadsResult;
      if (!xml) throw new Error("Invalid R2 multipart listing response");
    } finally { clearTimeout(timer); }
    for (const upload of xml.Upload || []) {
      if (upload.Key !== key || typeof upload.UploadId !== "string") continue;
      try { await env.ATTACHMENTS.resumeMultipartUpload(key, upload.UploadId).abort(); }
      catch (error) { if (!/NoSuchUpload|\(10024\)$/.test(String(error?.message))) throw error; }
    }
    if (xml.IsTruncated !== "true") return true;
    if (!xml.NextKeyMarker || !xml.NextUploadIdMarker) throw new Error("Missing R2 multipart pagination markers");
    url.searchParams.set("key-marker", xml.NextKeyMarker);
    url.searchParams.set("upload-id-marker", xml.NextUploadIdMarker);
  }
  return false;
}

export async function stopTokenHash(token) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
