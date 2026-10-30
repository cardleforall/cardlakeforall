const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { deflateRawSync, crc32 } = require('node:zlib');
const { validateUpload, FORMATS } = require('../../api/_lib/upload-validation');

// Real ZIP structure, generated in memory: fixtures never execute code or touch disk.
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value, options = {}] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const compressed = deflateRawSync(data);
    const checksum = options.badCrc ? 123 : crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(options.encrypted ? 1 : 0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(options.size ?? data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    header.copy(directory, 8, 6, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function officeEntries(kind = 'docx') {
  const word = kind === 'docx';
  const part = word ? 'word/document.xml' : 'xl/workbook.xml';
  const type = word ? 'wordprocessingml.document' : 'spreadsheetml.sheet';
  return [
    ['[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`],
    ['_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${part}"/></Relationships>`],
    [part, word ? '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>' : '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>'],
  ];
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const rejected = (buffer, name, code = 'INVALID_FILE_FORMAT') => assert.rejects(validateUpload(buffer, name), error => error.status === 415 && error.code === code);

test('accepts supported image signatures, PDF and UTF-8 text; returns canonical MIME', async () => {
  for (const [name, data] of [
    ['photo.PNG', png], ['animation.gif', gif],
    ['notes.txt', Buffer.from('Hello नमस्ते\n\tWorld')],
    ['pki.txt', Buffer.from('PKI documentation is plain text.')],
    ['notes.md', Buffer.from('# Heading\nSome text')],
    ['data.json', Buffer.from('\ufeff{"hello": true}')],
    ['document.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')],
  ]) assert.equal(await validateUpload(data, name), FORMATS[require('node:path').extname(name).toLowerCase()]);
  // Additional genuine assets already in the repository.
  const fs = require('node:fs');
  assert.equal(await validateUpload(fs.readFileSync('public/onboarding/feed.webp'), 'feed.webp'), 'image/webp');
  assert.equal(await validateUpload(fs.readFileSync('tests/unit/fixtures/photo.jpg'), 'photo.jpeg'), 'image/jpeg');
});

test('rejects executable, archive, legacy and macro extensions regardless of contents', async () => {
  for (const ext of ['exe', 'dll', 'bat', 'cmd', 'ps1', 'sh', 'js', 'html', 'svg', 'zip', 'rar', '7z', 'doc', 'xls', 'docm', 'xlsm', 'xlam', 'bin', '']) {
    await rejected(png, `file.${ext}`, 'UNSUPPORTED_FILE_TYPE');
  }
  await rejected(png, 'image.png.exe', 'UNSUPPORTED_FILE_TYPE');
});

test('rejects renamed binaries, mismatched images, malformed text/JSON and empty files', async () => {
  const exe = Buffer.alloc(256); exe.write('MZ');
  for (const name of ['photo.png', 'notes.txt', 'data.json', 'document.docx', 'sheet.xlsx']) await rejected(exe, name);
  await rejected(png, 'photo.jpg');
  await rejected(gif, 'photo.png');
  await rejected(Buffer.from('not an image'), 'photo.png');
  await rejected(Buffer.from([0xff, 0xfe, 0x41]), 'notes.txt');
  await rejected(Buffer.from('a\u0000b'), 'notes.md');
  await rejected(Buffer.from('{broken'), 'data.json');
  await rejected(Buffer.from('%PDF-1.7\ntruncated'), 'document.pdf');
  await rejected(Buffer.alloc(0), 'notes.txt');
  const archive = zip([['readme.txt', 'hello']]);
  for (const name of ['archive.txt', 'archive.png', 'archive.docx']) await rejected(archive, name);
});

test('accepts real Office package structure and rejects swapped document formats', async () => {
  for (const kind of ['docx', 'xlsx']) assert.equal(await validateUpload(zip(officeEntries(kind)), `file.${kind}`), FORMATS[`.${kind}`]);
  await rejected(zip(officeEntries('xlsx')), 'file.docx');
  await rejected(zip(officeEntries()), 'file.xlsx');
});

test('blocks Office macros, active objects and embedded executables even with renamed extensions', async () => {
  for (const name of ['word/vbaProject.bin', 'word/VbaData.xml', 'word/activeX/activeX1.xml', 'word/embeddings/file.exe', 'xl/macrosheets/sheet1.xml', 'custom/evil.exe', 'custom/archive.zip']) {
    await rejected(zip([...officeEntries(), [name, 'payload']]), 'renamed.docx');
  }
  const macro = officeEntries();
  macro[0][1] = macro[0][1].replace('</Types>', '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>');
  await rejected(zip(macro), 'renamed.docx');
  macro[0][1] = macro[0][1].replace('vbaProject', '&#118;baProject');
  await rejected(zip(macro), 'escaped.docx');
  macro[0][1] = macro[0][1].replace('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'application/vnd.ms-word.document.macroEnabled.main+xml');
  await rejected(zip(macro), 'renamed.docx');
});

test('fails closed for corrupt, encrypted, duplicate, traversing and oversized Office packages', async () => {
  await rejected(zip(officeEntries()).subarray(0, 80), 'broken.docx');
  await rejected(zip([...officeEntries(), ['word/document.xml', '<document/>']]), 'duplicate.docx');
  await rejected(zip([...officeEntries(), ['../escape.xml', '<root/>']]), 'traversal.docx');
  for (const options of [{ encrypted: true }, { badCrc: true }, { size: 40 * 1024 * 1024 }, { size: 1 }]) {
    await rejected(zip([...officeEntries(), ['custom/item.xml', '<root/>', options]]), 'invalid.docx');
  }
  await rejected(zip([...officeEntries(), ...Array.from({ length: 1000 }, (_, i) => [`custom/${i}.xml`, '<a/>'])]), 'many.docx');
  const dtd = officeEntries(); dtd[2][1] = '<!DOCTYPE document [<!ENTITY x "test">]><document>&x;</document>';
  await rejected(zip(dtd), 'dtd.docx');
  const broken = officeEntries(); broken[2][1] = '<document><body></document>';
  await rejected(zip(broken), 'broken.docx');
  const fake = officeEntries(); fake[2][1] = '<document xmlns="https://example.test/not-office"/>';
  await rejected(zip(fake), 'fake.docx');
});

test('multipart API rejects before storage and saves detected MIME for files and attachments', async () => {
  process.env.SYNC_TOKEN = 'offline-upload-test-token';
  const dbModule = require('../../api/_lib/db');
  let dbCalls = 0;
  dbModule.getSql = () => { dbCalls++; throw new Error('Rejected uploads must not reach the database'); };
  const blobPath = require.resolve('@vercel/blob');
  require(blobPath);
  const saved = [];
  require.cache[blobPath].exports = { ...require.cache[blobPath].exports, put: async (name, data, options) => {
    saved.push({ name, data, options }); return { url: 'https://example.test/private-blob' };
  } };
  const guardPath = require.resolve('../../api/_lib/session-guard');
  require(guardPath);
  require.cache[guardPath].exports = { withSessionGuard: handler => handler };
  // Keep the captured function stable while swapping its database target below.
  let sql;
  dbModule.getSql = () => { dbCalls++; if (!sql) throw new Error('Unexpected database access'); return sql; };
  const feed = require('../../api/feed');
  async function upload(name, data, type, fields = {}) {
    const boundary = 'offline-upload-boundary';
    const chunks = [];
    for (const [key, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`));
    const req = Readable.from([Buffer.concat(chunks)]);
    Object.assign(req, { method: 'POST', query: {}, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-sync-token': process.env.SYNC_TOKEN } });
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await feed(req, res);
    return res;
  }
  for (const fields of [{}, { parent_type: 'reminder', parent_id: '11111111-1111-4111-8111-111111111111' }]) {
    const res = await upload('innocent.png', Buffer.from('MZ' + '\0'.repeat(100)), 'image/png', fields);
    assert.equal(res.statusCode, 415);
    assert.equal(res.body.code, 'INVALID_FILE_FORMAT');
  }
  assert.equal(dbCalls, 0);
  assert.equal(saved.length, 0);
  const testDb = await require('./pg_harness').createTestDb();
  sql = testDb.sql;
  try {
    const file = await upload('image.png', png, 'application/octet-stream');
    assert.equal(file.statusCode, 201, JSON.stringify(file.body));
    const [stored] = await sql`select mime_type from files where id = ${file.body.id}`;
    assert.equal(stored.mime_type, 'image/png');
    const attachment = await upload('notes.md', Buffer.from('# Notes'), 'image/jpeg', { parent_type: 'file', parent_id: file.body.id });
    assert.equal(attachment.statusCode, 201, JSON.stringify(attachment.body));
    const [row] = await sql`select mime_type from attachments where id = ${attachment.body.attachment.id}`;
    assert.equal(row.mime_type, 'text/markdown');
    assert.deepEqual(saved.map(item => item.options.contentType), ['image/png', 'text/markdown']);
    assert.ok(saved.every(item => item.options.access === 'private'));
  } finally { await testDb.db.close(); }
});
