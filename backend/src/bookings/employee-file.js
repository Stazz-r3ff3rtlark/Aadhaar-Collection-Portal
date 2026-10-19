'use strict';

const ExcelJS = require('exceljs');
const { COLUMNS, REQUIRED_COLUMNS, MAX_ROWS, columnForHeader } = require('./employee-rows');
const { formatIstDate } = require('../lib/time');

// Employee list template (xlsx, csv) and reading an uploaded list into plain rows.
// Reading never saves anything; see employee-rows.js for the rules.

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 500;

const HEADER_LABELS = COLUMNS.map((c) => (c.key === 'vacant' ? 'Vacant (yes or no)' : c.label));

class FileProblem extends Error {}

// --- Template ----------------------------------------------------------------

async function buildTemplate(format) {
  if (format === 'csv') {
    // UTF-8 BOM so Excel opens names with non-ASCII characters correctly.
    return Buffer.from(`﻿${HEADER_LABELS.join(',')}\r\n`, 'utf8');
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Aadhaar Collection Portal';

  const sheet = workbook.addWorksheet('Employees', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = HEADER_LABELS.map((header, i) => ({
    header,
    key: COLUMNS[i].key,
    width: [28, 16, 32, 16, 20, 14, 14, 18][i],
    // Text format so codes and mobiles keep leading zeros and are not turned into numbers.
    style: { numFmt: '@' },
  }));
  sheet.getRow(1).font = { bold: true };
  const vacantColumn = String.fromCharCode(64 + HEADER_LABELS.length);
  for (let r = 2; r <= MAX_ROWS + 1; r += 1) {
    sheet.getCell(`${vacantColumn}${r}`).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"yes,no"'],
      showErrorMessage: true, errorTitle: 'Vacant', error: 'Choose yes or no, or leave blank (blank means no).',
    };
  }

  const help = workbook.addWorksheet('Instructions');
  help.getColumn(1).width = 110;
  [
    'How to fill in the employee list',
    '',
    'One row per traveller on the "Employees" sheet. Keep the header row as it is.',
    'Name, Employee code, Email and Mobile are required for every row that is not vacant.',
    'Email is where the traveller receives their one-time code, so it must be correct.',
    'Mobile: a 10-digit Indian mobile number (+91 or a leading 0 is fine).',
    'Department, Zone and HQ are optional.',
    'Vacant: "yes" for a position nobody will fill. Vacant rows may leave Name, Email and Mobile blank.',
    'Blank Vacant means "no". Vacant rows count as headcount only and get no invitations or reminders.',
    'Employee codes and emails must not repeat.',
    `Up to ${MAX_ROWS} rows. Dates, if you add any notes, are DD/MM/YYYY.`,
  ].forEach((line, i) => {
    help.getCell(`A${i + 1}`).value = line;
    if (i === 0) help.getCell('A1').font = { bold: true, size: 13 };
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// --- Reading -------------------------------------------------------------------

/**
 * Reads the zip central directory and refuses archives that would unpack to more than
 * MAX_UNZIPPED_BYTES or contain too many entries (zip bombs), before ExcelJS opens them.
 */
function checkZip(buffer) {
  const EOCD = 0x06054b50;
  const CDH = 0x02014b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new FileProblem('This is not a valid .xlsx file. Save it from Excel as .xlsx, or upload a .csv.');
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (entries > MAX_ZIP_ENTRIES) throw new FileProblem('This .xlsx file has too many parts to be an employee list.');
  let total = 0;
  for (let n = 0; n < entries; n += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CDH) {
      throw new FileProblem('This .xlsx file is damaged. Save it again from Excel, or upload a .csv.');
    }
    const size = buffer.readUInt32LE(offset + 24);
    if (size === 0xffffffff) throw new FileProblem('This .xlsx file is too large.');
    total += size;
    if (total > MAX_UNZIPPED_BYTES) throw new FileProblem('This .xlsx file is too large once opened.');
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
}

/** Excel cell value -> trimmed text. */
function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return formatIstDate(value);
  if (typeof value === 'number') return Number.isInteger(value) ? value.toFixed(0) : String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((p) => p.text).join('');
    if ('text' in value) return cellText(value.text); // hyperlinks (emails often are)
    if ('result' in value) return cellText(value.result); // formulas
    if ('error' in value) return '';
    return '';
  }
  return String(value).trim();
}

async function readXlsx(buffer) {
  checkZip(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new FileProblem('This .xlsx file could not be read. Save it again from Excel, or upload a .csv.');
  }
  const sheet = workbook.getWorksheet('Employees') || workbook.worksheets[0];
  if (!sheet) throw new FileProblem('The file has no sheets.');
  const lines = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cellText(cell.value); });
    lines.push({ rowNumber, cells: Array.from(cells, (c) => c ?? '') });
  });
  return lines;
}

/** RFC 4180 CSV (quotes, doubled quotes, CRLF or LF, BOM). */
function readCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const lines = [];
  let cells = [];
  let cell = '';
  let quoted = false;
  let rowNumber = 1;
  const endRow = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== '')) lines.push({ rowNumber, cells: cells.map((c) => c.trim()) });
    cells = [];
    cell = '';
    rowNumber += 1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; } else if (ch === '\n') endRow();
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || cells.length) endRow();
  return lines;
}

/**
 * Parses an uploaded employee list.
 * @returns { rows: [{ rowNumber, name, employeeCode, ... }], ignoredColumns: string[] }
 * @throws FileProblem with a message for the person uploading
 */
async function parseEmployeeFile(buffer, format) {
  if (!buffer?.length) throw new FileProblem('The file is empty.');
  if (buffer.length > MAX_FILE_BYTES) throw new FileProblem('The file is larger than 5 MB.');
  const lines = format === 'csv' ? readCsv(buffer) : await readXlsx(buffer);
  if (!lines.length) throw new FileProblem('The file is empty.');

  const [header, ...data] = lines;
  const keys = header.cells.map(columnForHeader);
  const missing = REQUIRED_COLUMNS.filter((k) => !keys.includes(k));
  if (missing.length) {
    const labels = missing.map((k) => COLUMNS.find((c) => c.key === k).label);
    throw new FileProblem(`The header row is missing: ${labels.join(', ')}. Download the template to see the expected columns.`);
  }
  const dupes = keys.filter((k, i) => k && keys.indexOf(k) !== i);
  if (dupes.length) throw new FileProblem('The header row has the same column twice.');

  const rows = data.filter((line) => line.cells.some((c) => c !== ''));
  if (!rows.length) throw new FileProblem('The file has a header row but no employees.');
  if (rows.length > MAX_ROWS) throw new FileProblem(`The file has ${rows.length} rows; the limit is ${MAX_ROWS}.`);

  return {
    rows: rows.map((line) => {
      const values = { rowNumber: line.rowNumber };
      keys.forEach((key, i) => { if (key) values[key] = line.cells[i] ?? ''; });
      return values;
    }),
    ignoredColumns: header.cells.filter((h, i) => h && !keys[i]),
  };
}

module.exports = { buildTemplate, parseEmployeeFile, FileProblem, MAX_FILE_BYTES };
