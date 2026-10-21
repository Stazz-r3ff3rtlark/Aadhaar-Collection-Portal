'use strict';

const sharp = require('sharp');
const heicDecode = require('heic-decode');
const { PDFDocument } = require('pdf-lib');

// PRD business rules, "Accepted files" and "Compression":
//   - JPG, PNG, HEIC (converted) and PDF; the type is read from the file's content, never
//     from its name, extension or the browser's claimed type;
//   - up to 10 MB before compression; PDFs up to 3 pages and not password-protected;
//   - images re-encoded to JPEG at about quality 85, long edge capped near 2400 px,
//     EXIF and GPS removed (sharp writes no metadata unless asked); PDFs kept as they are.
//
// Errors are UploadProblem with a message safe to show the employee. Nothing about the
// file's content is ever put in an error, log line or audit entry.

sharp.cache(false);

class UploadProblem extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'UploadProblem';
    this.reason = reason;
  }
}

const NOT_ACCEPTED = 'This file type is not accepted. Upload a photo (JPG, PNG or HEIC) or a PDF.';
const UNREADABLE = 'We could not read this file. Please take a fresh photo or export a new PDF and try again.';

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/** 'jpeg' | 'png' | 'heic' | 'pdf' | null, from the first bytes of the file. */
function sniffType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const boxSize = buffer.readUInt32BE(0);
    const brands = [buffer.subarray(8, 12).toString('latin1')];
    for (let i = 16; i + 4 <= Math.min(boxSize, buffer.length, 64); i += 4) brands.push(buffer.subarray(i, i + 4).toString('latin1'));
    // AVIF shares the HEIF container but is not an accepted type.
    if (brands.includes('avif') || brands.includes('avis')) return null;
    if (brands.some((b) => HEIC_BRANDS.has(b))) return 'heic';
  }
  return null;
}

async function compressImage(input, options, config) {
  try {
    return await sharp(input, { ...options, limitInputPixels: config.maxImagePixels, failOn: 'error' })
      .rotate() // apply the camera's orientation before the EXIF data is dropped
      .resize({ width: config.maxEdgePx, height: config.maxEdgePx, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: config.jpegQuality, chromaSubsampling: '4:4:4' })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new UploadProblem('unreadable_image', UNREADABLE);
  }
}

async function decodeHeic(buffer, config) {
  let image;
  try {
    image = await heicDecode({ buffer });
  } catch {
    throw new UploadProblem('unreadable_image', UNREADABLE);
  }
  if (image.width * image.height > config.maxImagePixels) throw new UploadProblem('unreadable_image', UNREADABLE);
  return { input: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), options: { raw: { width: image.width, height: image.height, channels: 4 } } };
}

async function checkPdf(buffer, config) {
  let doc;
  try {
    doc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true });
  } catch {
    throw new UploadProblem('unreadable_pdf', UNREADABLE);
  }
  if (doc.isEncrypted) {
    throw new UploadProblem('pdf_password', 'This PDF is password-protected. Remove the password (or take photos of the card) and upload again.');
  }
  const pages = doc.getPageCount();
  if (pages < 1) throw new UploadProblem('unreadable_pdf', UNREADABLE);
  if (pages > config.maxPdfPages) {
    throw new UploadProblem('pdf_too_many_pages', `This PDF has ${pages} pages. Upload a PDF of at most ${config.maxPdfPages} pages with just your Aadhaar.`);
  }
  return pages;
}

/**
 * Checks and prepares one uploaded file.
 * @param buffer raw upload
 * @param config config.upload
 * @returns { data, mimeType, kind: 'image' | 'pdf', pageCount, sourceType }
 */
async function processUpload(buffer, config) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new UploadProblem('empty', 'The file is empty. Please choose it again.');
  if (buffer.length > config.maxBytes) {
    throw new UploadProblem('too_large', `This file is larger than ${Math.round(config.maxBytes / 1024 / 1024)} MB. Take a new photo or upload a smaller file.`);
  }
  const type = sniffType(buffer);
  if (!type) throw new UploadProblem('invalid_type', NOT_ACCEPTED);

  if (type === 'pdf') {
    const pageCount = await checkPdf(buffer, config);
    return { data: buffer, mimeType: 'application/pdf', kind: 'pdf', pageCount, sourceType: type };
  }

  const { input, options } = type === 'heic' ? await decodeHeic(buffer, config) : { input: buffer, options: {} };
  const { data } = await compressImage(input, options, config);
  return { data, mimeType: 'image/jpeg', kind: 'image', pageCount: null, sourceType: type };
}

module.exports = { processUpload, sniffType, UploadProblem };
