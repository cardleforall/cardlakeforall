# Upload formats

New files and card attachments are checked by `api/_lib/upload-validation.js`
before any blob is stored or file/attachment row is created. The server requires
an allowed filename extension and matching content; it does not trust the
multipart Content-Type. The detected canonical MIME type is stored and served.

Allowed: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.pdf`, `.txt`, `.md`, `.json`,
`.docx`, `.xlsx` (case-insensitive). Text must be valid UTF-8 without binary
control characters; JSON must also parse. Binary files are checked by signature;
PDFs additionally require a PDF header and end marker.

DOCX/XLSX files must be readable ZIP packages with the matching Office content
type, package relationship, and main XML document. Encrypted ZIP entries,
duplicate member names, macros, embedded objects, and unsupported package members
are rejected. To bound decompression work, packages may have at most 1,000 entries
and 32 MiB of expanded data; inspected XML parts may be at most 8 MiB each. CRCs
and decompressed lengths are verified. Office XML must be UTF-8 without DTDs.

Executable files, standalone archives, unknown binary files, legacy `.doc`/`.xls`,
and macro-enabled Office formats such as `.docm`/`.xlsm` are not supported.
Save legacy documents as DOCX/XLSX without macros or embedded files before uploading.
Unsupported extensions return HTTP 415 / `UNSUPPORTED_FILE_TYPE`; mismatched,
malformed, or disallowed contents return HTTP 415 / `INVALID_FILE_FORMAT`.
Empty files are rejected. Existing upload size/storage/rate limits still apply.

These checks identify formats and restrict uploads; they are not antivirus,
content moderation, or a guarantee that a document is safe to open. Plain text
can contain code as text. Existing stored files are not rescanned and download
behavior is unchanged. No external scanning service or subscription is used.

Runtime: Node.js 22 (matching CI and the package engine setting). Run the focused offline tests with
`node --test tests/unit/upload_validation.test.js`, or use `npm run test:lite`.
