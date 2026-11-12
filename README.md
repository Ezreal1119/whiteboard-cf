# One Day Board

A temporary clipboard for text, images, and files, built with Cloudflare Workers, a SQLite-backed Durable Object, and a private R2 bucket. Anyone with the board URL can read, edit, upload, and delete content.

- Text expires 24 hours after the latest edit. Reading does not extend its lifetime.
- Each file expires independently 24 hours after a successful upload. Text edits do not extend file lifetimes.
- Choose multiple files, drag them into the upload area, or paste screenshots. Common raster images have previews; other files (including HTML and SVG) are served as downloads.
- Limits: 100,000 text characters, 20 MB per file, 20 files, and 100 MB total attachments.
- Emptying the text field keeps attachments. **Clear all** removes text and all attachments.

## Local development and checks

```bash
npm ci
npm run dev
npm run check
npm test
npx wrangler deploy --dry-run
```

Local development uses local Durable Object and R2 storage; it does not upload to the production bucket. Integration tests use isolated in-memory Miniflare storage and cover expiry, download behavior, quotas, cleanup failures and retries, and interrupted uploads.

## First production setup

The Worker name and Durable Object migration remain unchanged to preserve the existing deployment and storage namespace. Create the private bucket named in `wrangler.jsonc` in the same Cloudflare account as the Worker:

```bash
npx wrangler r2 bucket create whiteboard-attachments
npx wrangler r2 bucket lifecycle add whiteboard-attachments expire-attachments attachments/ --expire-days 1
npm run deploy
```

Skip bucket creation if it already exists. R2 must be enabled for the account. Keep public bucket access disabled: previews and downloads must pass through the Worker to enforce expiration. No R2 API secrets are needed in the browser; the Worker accesses R2 through its `ATTACHMENTS` binding.

The application denies new preview/download requests at expiry even if storage cleanup is delayed. The Durable Object alarm deletes expired files without needing an open browser. Failed deletes remain hidden with durable retry records and retry every minute; the R2 lifecycle rule is a fallback for leftover objects. R2 lifecycle deletion is asynchronous and can occur after the expiry time, so it is not used to enforce download access. Files already downloaded to a device cannot be recalled.

The existing ten-minute text record keeps its saved expiration when deploying; new edits use the new 24-hour TTL. `BOARD_TTL_SECONDS` defaults to 86400 (maximum 86400); file retention is always 24 hours.
