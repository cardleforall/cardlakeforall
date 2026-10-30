const path = require('node:path');
const { crc32 } = require('node:zlib');
const yauzl = require('yauzl');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { LimitError } = require('./limits');

// Extensions are a policy boundary; MIME types supplied by clients are not.
const FORMATS = Object.freeze({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});
const SUPPORTED = 'Use JPG, PNG, GIF, WebP, PDF, TXT, MD, JSON, DOCX, or XLSX.';
const OFFICE = {
  '.docx': { part: 'word/document.xml', root: 'document', vocabulary: 'wordprocessingml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' },
  '.xlsx': { part: 'xl/workbook.xml', root: 'workbook', vocabulary: 'spreadsheetml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' },
};
const MAX_ENTRIES = 1000;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const OFFICE_MEMBER = /\.(?:xml|rels|png|jpe?g|gif|webp|bmp|tiff?|emf|wmf|odttf|ttf|woff2?)$/i;
const ACTIVE_MEMBER = /(?:^|\/)(?:vbaproject[^/]*|vbadata[^/]*|activex|embeddings|macrosheets|intlmacrosheets)(?:\/|\.|$)/i;
const ACTIVE_CONTENT = /macroenabled|vbaproject|vbadata|activex|oleobject|macrosheet/i;
let detector;

function invalid(message = 'The file contents do not match a supported format.') {
  return new LimitError(415, 'INVALID_FILE_FORMAT', `${message} ${SUPPORTED}`);
}

function utf8(buffer) {
  // Reject binary controls and malformed UTF-8 rather than silently replacing bytes.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw invalid();
  return text;
}

function xml(buffer, root, namespaces) {
  if (buffer.length > MAX_XML_BYTES) throw invalid('This Office document is too complex to validate.');
  const text = utf8(buffer);
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw invalid();
  // DTDs are forbidden above; decode standard/numeric references so escaped
  // content-type names cannot bypass the macro checks.
  const document = new XMLParser({ ignoreAttributes: false, processEntities: true, htmlEntities: {} }).parse(text);
  const roots = Object.keys(document).filter(name => !name.startsWith('?'));
  if (roots.length !== 1 || roots[0].split(':').pop() !== root) throw invalid();
  const name = roots[0];
  const node = document[name];
  const namespace = node?.[name.includes(':') ? `@_xmlns:${name.split(':')[0]}` : '@_xmlns'];
  if (!namespaces.includes(namespace)) throw invalid();
  return node;
}

const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const elements = (node, name) => Object.entries(node).filter(([key]) => !key.startsWith('@_') && key.split(':').pop() === name).flatMap(([, value]) => array(value));

// Office formats are ZIP packages. Read bounded entries without extracting to disk,
// checking the package manifest and main document, not just the ZIP signature.
function inspectOffice(buffer, format) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(invalid());
      let stopped = false;
      let expanded = 0;
      const names = new Set();
      const parts = new Map();
      const fail = error => {
        if (stopped) return;
        stopped = true;
        zip.close();
        reject(error instanceof LimitError ? error : invalid());
      };
      zip.on('error', fail);
      if (zip.entryCount > MAX_ENTRIES) return fail(invalid('This Office document has too many components.'));
      zip.on('entry', entry => {
        if (stopped) return;
        const name = entry.fileName;
        const key = name.toLowerCase();
        if (names.has(key) || /[%\u0000-\u001f]/.test(name) || (entry.generalPurposeBitFlag & 1)
            || ![0, 8].includes(entry.compressionMethod)) return fail(invalid());
        names.add(key);
        if (ACTIVE_MEMBER.test(name) || (!name.endsWith('/') && !OFFICE_MEMBER.test(name))) {
          return fail(invalid('Office macros and embedded files are not supported.'));
        }
        expanded += entry.uncompressedSize;
        if (expanded > MAX_EXPANDED_BYTES) return fail(invalid('This Office document expands beyond the validation limit.'));
        if (name.endsWith('/')) {
          if (entry.uncompressedSize !== 0) return fail(invalid());
          zip.readEntry();
          return;
        }
        const keep = name === '[Content_Types].xml' || name === '_rels/.rels' || name === format.part;
        if (keep && entry.uncompressedSize > MAX_XML_BYTES) return fail(invalid());
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          let size = 0;
          let checksum = 0;
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', chunk => {
            size += chunk.length;
            if (size > entry.uncompressedSize || size > MAX_EXPANDED_BYTES) {
              stream.destroy();
              fail(invalid());
              return;
            }
            checksum = crc32(chunk, checksum);
            if (keep) chunks.push(chunk);
          });
          stream.on('end', () => {
            if (stopped) return;
            if (size !== entry.uncompressedSize || checksum !== entry.crc32) return fail(invalid());
            if (keep) parts.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => {
        if (stopped) return;
        try {
          if (!parts.has('[Content_Types].xml') || !parts.has('_rels/.rels') || !parts.has(format.part)) throw invalid();
          const manifest = xml(parts.get('[Content_Types].xml'), 'Types', ['http://schemas.openxmlformats.org/package/2006/content-types']);
          const overrides = elements(manifest, 'Override');
          const declarations = [...overrides, ...elements(manifest, 'Default')];
          if (declarations.some(item => ACTIVE_CONTENT.test(String(item['@_ContentType'])))) {
            throw invalid('Macro-enabled Office documents are not supported.');
          }
          const main = overrides.filter(item => item['@_PartName'] === `/${format.part}`);
          if (main.length !== 1 || main[0]['@_ContentType'] !== format.type) throw invalid();
          const relationships = elements(xml(parts.get('_rels/.rels'), 'Relationships', ['http://schemas.openxmlformats.org/package/2006/relationships']), 'Relationship');
          const office = relationships.filter(item => /^https?:\/\/(?:schemas\.openxmlformats\.org\/officeDocument\/2006|purl\.oclc\.org\/ooxml\/officeDocument)\/relationships\/officeDocument$/.test(item['@_Type']));
          if (office.length !== 1 || office[0]['@_TargetMode'] === 'External'
              || String(office[0]['@_Target']).replace(/^\//, '') !== format.part) throw invalid();
          xml(parts.get(format.part), format.root, [
            `http://schemas.openxmlformats.org/${format.vocabulary}/2006/main`,
            `http://purl.oclc.org/ooxml/${format.vocabulary}/main`,
          ]);
          stopped = true;
          resolve();
        } catch (error) { fail(error); }
      });
      zip.readEntry();
    });
  });
}

async function validateUpload(buffer, filename) {
  const extension = path.extname(filename).toLowerCase();
  const mimeType = FORMATS[extension];
  if (!mimeType) throw new LimitError(415, 'UNSUPPORTED_FILE_TYPE', `This file type is not supported. ${SUPPORTED}`);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw invalid('Empty files are not supported.');
  try {
    if (OFFICE[extension]) {
      if (!buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw invalid();
      await inspectOffice(buffer, OFFICE[extension]);
    } else {
      // Never let a renamed ZIP reach the generic detector's archive parser.
      if (buffer.length >= 4 && [0x04034b50, 0x06054b50, 0x08074b50].includes(buffer.readUInt32LE(0))) throw invalid();
      const isText = ['.txt', '.md', '.json'].includes(extension);
      const text = isText ? utf8(buffer) : null;
      detector ||= import('file-type');
      const detected = await (await detector).fileTypeFromBuffer(buffer);
      if (isText) {
        if (detected) throw invalid();
        if (extension === '.json') JSON.parse(text);
      } else if (detected?.mime !== mimeType) {
        throw invalid();
      }
      if (extension === '.pdf' && (!/^%PDF-\d\.\d/.test(buffer.subarray(0, 8).toString('ascii'))
          || !/%%EOF\s*$/.test(buffer.subarray(-1024).toString('latin1')))) throw invalid();
    }
    return mimeType;
  } catch (error) {
    if (error instanceof LimitError) throw error;
    throw invalid();
  }
}

module.exports = { validateUpload, FORMATS };
