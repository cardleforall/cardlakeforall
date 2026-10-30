# Cardlake limits

Cardlake enforces all limits on the server. The browser and MCP tools receive
the same clear errors, but client-side hints are only conveniences: changing
the browser cannot bypass the limits.

| Environment variable | Default | What it protects |
| --- | ---: | --- |
| `CARDLE_MAX_CARDS_PER_USER` | 500 | Active cards, including standalone files |
| `CARDLE_MAX_TEXT_BYTES_PER_USER` | 2 MiB | All stored card text for one user |
| `CARDLE_MAX_ATTACHMENTS_PER_CARD` | 5 | Attachments on one card |
| `CARDLE_MAX_FILE_BYTES` | 4 MiB | One uploaded file; safely below the Vercel Function request limit |
| `CARDLE_MAX_FILE_BYTES_PER_USER` | 50 MiB | Active Blob-backed files and attachments for one user |
| `CARDLE_MAX_UPLOADS_PER_DAY` | 20 | Rolling 24-hour upload rate per user |
| `CARDLE_MAX_FILENAME_CHARS` | 128 | Uploaded filename length |
| `CARDLE_MAX_TITLE_CHARS` | 200 | Titles, people, and section titles |
| `CARDLE_MAX_CONTENT_CHARS` | 50,000 | Long text fields |
| `CARDLE_MAX_URL_CHARS` | 2,048 | URLs and other short reference fields |
| `CARDLE_MAX_WORK_ITEMS` | 100 | Checklist entries on a work card |
| `CARDLE_MAX_JSON_BODY_BYTES` | 256 KiB | JSON request body size |
| `CARDLE_BLOB_STORAGE_ALERT_BYTES` | 20 GiB | Service-wide Blob warning threshold |
| `CARDLE_BLOB_STORAGE_HARD_LIMIT_BYTES` | 30 GiB | Service-wide Blob upload stop threshold |

Limit responses include an HTTP status, a stable `code`, and safe usage
details. Card/text/file-storage and attachment caps return `409`; oversized
files or text return `413`; the upload rate returns `429`. Unexpected server
failures deliberately use a generic message, so database/provider internals
are not disclosed to users.

Set the variables in Vercel for Production, Preview, and Development as
appropriate, and in `.env.local` for local development. Do not commit
`.env.local`.
