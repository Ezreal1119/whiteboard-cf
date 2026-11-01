# Ten Minute Board

A tiny Cloudflare Worker that synchronizes one temporary text board across devices. Content is stored in a strongly consistent Durable Object and deleted ten minutes after the latest edit.

## Commands

```bash
npm install
npm run dev
npm run check
npm run deploy
```

The board is available directly from the deployed root URL. Anyone with the URL can read and edit it; all content is deleted ten minutes after the latest edit.
