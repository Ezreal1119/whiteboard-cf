# One Day Board

A temporary clipboard for text, images, and files, built with Cloudflare Workers, a SQLite-backed Durable Object, and a private R2 bucket. Anyone with the board URL can read, edit, upload, and delete content.

- Text expires 24 hours after the latest edit. Reading does not extend its lifetime.
- Each completed file expires independently 72 hours after upload. Text edits do not extend file lifetimes.
- Limits: 100,000 text characters, **3 GB per file**, **20 GB total**, and 20 files, including upload reservations. GB means 1,000,000,000 bytes.
- The browser and terminal client automatically upload in **32 MiB parts**, retry transient failures, and keep file bodies out of Worker memory.
- Choose multiple files, drop them into the upload area, or paste screenshots. The browser has progress and a cancel button. Common raster images have previews; other files, including HTML and SVG, download as attachments.
- Emptying the text field keeps attachments. **Clear all** removes text, files, and pending uploads. Downloads support HTTP byte ranges.

## Local development and checks

```bash
npm ci
npm run dev
npm run check
npm test
npx wrangler deploy --dry-run
```

Node.js 22+ and Python 3 are required for the checks. Tests use isolated Miniflare storage and cover text retention, multipart assembly, streaming downloads, file-size validation, simultaneous quota reservations, transient failures, cancellation, interrupted completion, cleanup retries, and the terminal client. Local development uses local Durable Object and R2 storage.

## Terminal client

Install the dependency-free Python/curl client:

```bash
mkdir -p ~/.local/bin
install -m 755 scripts/patrick-wb.py ~/.local/bin/patrick-wb
```

The `wb` case in the `patrick` shell function should delegate to this helper:

```bash
wb)
    shift
    python3 "$HOME/.local/bin/patrick-wb" "$@"
    return $?
    ;;
```

Keep `patrick list` up to date when changing commands or options. Supported uses:

```bash
patrick wb "Text to share"
patrick wb -f ~/Downloads/firmware.apk
patrick wb --get
```

The helper reads one part at a time, displays progress, retries failed requests, and cancels the reservation on errors or Ctrl-C. The `--get` command prints all text, active attachment download links, and storage usage.

## HTTP API

All routes are relative to `https://whiteboard.patrick-shenzhen.org`. No API key is required. Non-browser clients can omit the Origin header.

| Method | Route | Request / response |
| --- | --- | --- |
| GET | `/api/board` | Text, visible files, limits, and used/reserved bytes |
| PUT | `/api/board` | JSON `{ "text": "..." }`; replaces text only |
| DELETE | `/api/board` | Clears text, attachments, and pending uploads |
| POST | `/api/uploads` | JSON `{ "id": "optional-client-uuid", "name": "firmware.apk", "size": 123, "type": "application/octet-stream" }` |
| GET | `/api/uploads/{id}` | Session status, part size/count, uploaded part numbers, and the file when complete |
| PUT | `/api/uploads/{id}/parts/{number}` | Raw bytes with `X-Part-Size` equal to the exact byte count |
| POST | `/api/uploads/{id}/complete` | No body; assembles the server's validated part list and returns file metadata |
| DELETE | `/api/uploads/{id}` | Cancels a pending session and releases quota after storage cleanup |
| POST | `/api/files` | Legacy raw upload, up to 32 MiB; requires Content-Length, URL-encoded X-File-Name, and Content-Type |
| GET / HEAD | `/api/files/{id}` | Preview or download; append `?download` to force download |
| DELETE | `/api/files/{id}` | Deletes the attachment |

A create response includes `id`, `partSize`, `partCount`, `status`, and `expiresAt`. Part numbers start at 1. Every part must match the server's part size except the last part, which must match the exact remaining size. Files become visible only after successful completion. Retrying creation with the same UUID and metadata, individual parts, and completion is safe. An already completed file cannot be cancelled through the upload endpoint.

The full declared size is reserved atomically before accepting parts, so concurrent uploads cannot exceed 20 GB. Expired, failed, and deleting files continue to consume reserved capacity until their R2 data is removed. Pending sessions expire 24 hours after creation; alarms abort their multipart uploads and release reservations. R2's one-day incomplete-upload lifecycle is an additional fallback. A client that is disconnected during cancellation can rely on this cleanup, or cancel using its known session ID.

## Production setup and updates

The Worker name and Durable Object class remain unchanged to preserve existing deployment and storage. On first setup, create the private bucket named in `wrangler.jsonc`:

```bash
npx wrangler r2 bucket create whiteboard-attachments
npx wrangler r2 bucket lifecycle set whiteboard-attachments --file r2-lifecycle.json
npm run deploy
```

For the existing deployment, apply the lifecycle configuration before deploying the multipart change. The supplied policy preserves three-day object deletion and sets incomplete multipart abortion to one day. `lifecycle set` replaces the bucket's policy; retain any additional rules if this bucket is customized later.

The Git repository can be connected to Workers Builds: push to `main`, run `npm run check && npm test`, then `npm run deploy`. Keep the dashboard Worker name consistent with `wrangler.jsonc`.

Keep public R2 bucket access disabled: previews and downloads pass through the Worker to enforce expiration. R2 secrets are never sent to clients. The application rejects new preview/download requests at expiry even if physical cleanup is delayed. Failed deletes stay hidden with durable retry records and retry every minute. R2 lifecycle deletion is asynchronous, so it is a fallback rather than the access-control clock. Files already downloaded cannot be recalled.

`BOARD_TTL_SECONDS` defaults to 86400 (maximum 86400); completed file retention is always 72 hours. Unexpired attachments from the old one-day policy are extended to 72 hours after their original upload; deleted or expired files are not restored.
