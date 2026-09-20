#!/usr/bin/env node
// Renders one of the plain-markdown audit reports in docs/ into a printable
// PDF, using the same pdfkit dependency and palette api/_lib/pdf-report.js
// already uses for emailed customer reports — no headless browser, no native
// dependency, safe to run anywhere this repo runs.
//
// This is a small, line-based renderer for the specific markdown this
// codebase's own audit docs use (headings, paragraphs, bullet lists, pipe
// tables, a horizontal rule, and **bold** inline) — not a general CommonMark
// engine. It is deliberately narrow rather than pulling in a markdown
// dependency for a handful of house documents with a consistent shape.
//
// Usage:
//   node scripts/markdown-to-pdf.js <input.md> <output.pdf> ["Title override"]

'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const [, , inputArg, outputArg, titleArg] = process.argv;

if (!inputArg || !outputArg) {
  console.error('Usage: node scripts/markdown-to-pdf.js <input.md> <output.pdf> ["Title override"]');
  process.exit(1);
}

const inputPath = path.resolve(inputArg);
const outputPath = path.resolve(outputArg);
const source = fs.readFileSync(inputPath, 'utf8');

const COLORS = {
  heading: '#1F1B16',
  body: '#3A342B',
  muted: '#7A7163',
  accent: '#4FB6E8',
  rule: '#D8D2C4',
  tableHeadBg: '#EFE9DC',
  tableBorder: '#C9C1AF',
};

const PAGE = { size: 'LETTER', margins: { top: 64, bottom: 56, left: 54, right: 54 } };
const CONTENT_WIDTH = 612 - PAGE.margins.left - PAGE.margins.right;

// --- markdown -> blocks -------------------------------------------------

function parseInline(text) {
  // Splits on **bold** only — the one inline style these documents use.
  const parts = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), bold: false });
    parts.push({ text: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bold: false });
  return parts.length ? parts : [{ text, bold: false }];
}

function isTableRule(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
}

function parseBlocks(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      blocks.push({ type: 'heading', level, text: line.replace(/^#{1,4}\s*/, '').trim() });
      i += 1;
      continue;
    }

    if (/^---+\s*$/.test(line.trim()) && !isTableRule(line)) {
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }

    if (line.trim().startsWith('|') && lines[i + 1] && isTableRule(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', text: quoteLines.join(' ').trim() });
      continue;
    }

    if (/^\s*\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s/, '').trim());
        i += 1;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    if (/^\s*[-*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s/, '').trim());
        i += 1;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    // Paragraph: consecutive non-blank, non-special lines joined with a space.
    const paraLines = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim()
      && !/^#{1,4}\s/.test(lines[i]) && !lines[i].trim().startsWith('|')
      && !/^>\s?/.test(lines[i]) && !/^\s*[-*]\s/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i])
      && !/^---+\s*$/.test(lines[i].trim())) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'para', text: paraLines.join(' ') });
  }

  return blocks;
}

// --- rendering -------------------------------------------------------------

function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

function renderInline(doc, text, opts) {
  const parts = parseInline(text);
  const size = (opts && opts.size) || 10.5;
  const color = (opts && opts.color) || COLORS.body;
  doc.fontSize(size).fillColor(color);
  parts.forEach((part, idx) => {
    doc.font(part.bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(part.text, { continued: idx < parts.length - 1, width: opts && opts.width, lineGap: 3 });
  });
}

function renderHeading(doc, block) {
  const sizes = { 1: 20, 2: 15, 3: 12.5, 4: 11 };
  const gapBefore = { 1: 22, 2: 18, 3: 14, 4: 10 };
  const gapAfter = { 1: 10, 2: 8, 3: 6, 4: 5 };
  if (block.level === 1) doc.addPage();
  else ensureSpace(doc, sizes[block.level] + gapBefore[block.level] + gapAfter[block.level]);

  doc.moveDown(0);
  doc.y += gapBefore[block.level] / 2;
  doc.font('Helvetica-Bold').fontSize(sizes[block.level]).fillColor(COLORS.heading);
  doc.text(block.text, { width: CONTENT_WIDTH });
  if (block.level <= 2) {
    doc.moveTo(PAGE.margins.left, doc.y + 2)
      .lineTo(PAGE.margins.left + (block.level === 1 ? CONTENT_WIDTH : 90), doc.y + 2)
      .strokeColor(block.level === 1 ? COLORS.accent : COLORS.rule)
      .lineWidth(block.level === 1 ? 2 : 1)
      .stroke();
  }
  doc.y += gapAfter[block.level];
}

function renderPara(doc, block) {
  ensureSpace(doc, 14);
  renderInline(doc, block.text, { width: CONTENT_WIDTH });
  doc.y += 7;
}

function renderQuote(doc, block) {
  ensureSpace(doc, 24);
  const x = PAGE.margins.left + 14;
  const w = CONTENT_WIDTH - 14;
  doc.font('Helvetica-Oblique').fontSize(11.5).fillColor(COLORS.heading);
  const top = doc.y;
  doc.text(block.text, x, doc.y, { width: w });
  doc.moveTo(PAGE.margins.left, top - 2).lineTo(PAGE.margins.left, doc.y + 2)
    .strokeColor(COLORS.accent).lineWidth(2.5).stroke();
  doc.y += 10;
}

function renderList(doc, block) {
  const startX = PAGE.margins.left + 8;
  const width = CONTENT_WIDTH - 8;
  block.items.forEach((item, idx) => {
    ensureSpace(doc, 13);
    const bullet = block.ordered ? `${idx + 1}.` : '• ';
    renderInlineAt(doc, `${bullet}  ${item}`, startX, doc.y, width);
    doc.y += 3;
  });
  doc.y += 4;
}

function renderInlineAt(doc, text, x, y, width) {
  const parts = parseInline(text);
  doc.fontSize(10.5).fillColor(COLORS.body);
  let first = true;
  parts.forEach((part, idx) => {
    doc.font(part.bold ? 'Helvetica-Bold' : 'Helvetica');
    if (first) {
      doc.text(part.text, x, y, { continued: idx < parts.length - 1, width, lineGap: 3 });
      first = false;
    } else {
      doc.text(part.text, { continued: idx < parts.length - 1, width, lineGap: 3 });
    }
  });
}

function stripInlineMarkers(text) {
  return String(text).replace(/\*\*(.+?)\*\*/g, '$1');
}

function renderTable(doc, block) {
  const cols = block.header.length;
  // Wider first/last columns for the common "Promise/Fix" shape; otherwise
  // spread evenly. Kept simple rather than measuring content, matching how
  // small and fixed the set of tables in these documents is.
  let fractions;
  if (cols === 5) fractions = [0.20, 0.28, 0.15, 0.09, 0.28];
  else if (cols === 3) fractions = [0.22, 0.39, 0.39];
  else fractions = Array(cols).fill(1 / cols);

  const widths = fractions.map((f) => f * CONTENT_WIDTH);
  const fontSize = cols >= 5 ? 7.6 : 8.6;
  const cellPad = 5;

  function rowHeight(cells, bold) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    let max = 0;
    cells.forEach((c, idx) => {
      const h = doc.heightOfString(stripInlineMarkers(c || ''), { width: widths[idx] - cellPad * 2 });
      if (h > max) max = h;
    });
    return max + cellPad * 2;
  }

  function drawRow(cells, y, height, opts) {
    const bold = opts && opts.bold;
    const bg = opts && opts.bg;
    let x = PAGE.margins.left;
    if (bg) {
      doc.rect(PAGE.margins.left, y, CONTENT_WIDTH, height).fill(bg);
    }
    cells.forEach((c, idx) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(COLORS.body);
      doc.text(stripInlineMarkers(c || ''), x + cellPad, y + cellPad, { width: widths[idx] - cellPad * 2 });
      x += widths[idx];
    });
    // column separators + bottom rule
    x = PAGE.margins.left;
    doc.strokeColor(COLORS.tableBorder).lineWidth(0.5);
    cells.forEach((c, idx) => {
      doc.moveTo(x, y).lineTo(x, y + height).stroke();
      x += widths[idx];
    });
    doc.moveTo(x, y).lineTo(x, y + height).stroke();
    doc.moveTo(PAGE.margins.left, y + height).lineTo(PAGE.margins.left + CONTENT_WIDTH, y + height).stroke();
  }

  const headerHeight = rowHeight(block.header, true);
  ensureSpace(doc, headerHeight + 20);
  doc.moveTo(PAGE.margins.left, doc.y).lineTo(PAGE.margins.left + CONTENT_WIDTH, doc.y)
    .strokeColor(COLORS.tableBorder).lineWidth(0.5).stroke();
  drawRow(block.header, doc.y, headerHeight, { bold: true, bg: COLORS.tableHeadBg });
  doc.y += headerHeight;

  block.rows.forEach((row) => {
    const h = rowHeight(row, false);
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      // repeat header on the new page
      const hh = rowHeight(block.header, true);
      doc.moveTo(PAGE.margins.left, doc.y).lineTo(PAGE.margins.left + CONTENT_WIDTH, doc.y)
        .strokeColor(COLORS.tableBorder).lineWidth(0.5).stroke();
      drawRow(block.header, doc.y, hh, { bold: true, bg: COLORS.tableHeadBg });
      doc.y += hh;
    }
    drawRow(row, doc.y, h);
    doc.y += h;
  });
  doc.y += 12;
}

function renderRule(doc) {
  ensureSpace(doc, 14);
  doc.moveTo(PAGE.margins.left, doc.y).lineTo(PAGE.margins.left + CONTENT_WIDTH, doc.y)
    .strokeColor(COLORS.rule).lineWidth(0.75).stroke();
  doc.y += 12;
}

// --- run ---------------------------------------------------------------

const blocks = parseBlocks(source);
const firstHeading = blocks.find((b) => b.type === 'heading' && b.level === 1);
const title = titleArg || (firstHeading ? firstHeading.text : path.basename(inputPath, '.md'));

const doc = new PDFDocument(PAGE, { bufferPages: true, info: { Title: title, Author: 'StreamNavigator' } });
doc.pipe(fs.createWriteStream(outputPath));

// Cover
doc.font('Helvetica-Bold').fontSize(23).fillColor(COLORS.heading);
doc.text(title, PAGE.margins.left, 200, { width: CONTENT_WIDTH, align: 'left' });
doc.moveTo(PAGE.margins.left, doc.y + 16).lineTo(PAGE.margins.left + 140, doc.y + 16)
  .strokeColor(COLORS.accent).lineWidth(3).stroke();
doc.moveDown(3);
doc.font('Helvetica').fontSize(11).fillColor(COLORS.muted);
doc.text('StreamNavigator — Engine Audit', PAGE.margins.left, doc.y + 20, { width: CONTENT_WIDTH });
doc.text(new Date().toISOString().slice(0, 10), { width: CONTENT_WIDTH });
doc.addPage();

// Skip the H1 in the body — it is now the cover title — everything else
// prints in order.
let printedH1 = false;
for (const block of blocks) {
  if (block.type === 'heading' && block.level === 1) {
    if (!printedH1) { printedH1 = true; continue; }
    renderHeading(doc, block);
    continue;
  }
  switch (block.type) {
    case 'heading': renderHeading(doc, block); break;
    case 'para': renderPara(doc, block); break;
    case 'list': renderList(doc, block); break;
    case 'table': renderTable(doc, block); break;
    case 'quote': renderQuote(doc, block); break;
    case 'rule': renderRule(doc); break;
    default: break;
  }
}

// Footer: page numbers, added last across every buffered page.
const range = doc.bufferedPageRange();
for (let i = range.start; i < range.start + range.count; i += 1) {
  doc.switchToPage(i);
  if (i === range.start) continue; // no footer on the cover
  doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted);
  doc.text(
    `StreamNavigator — Insurance Engine Audit        ${i - range.start} / ${range.count - 1}`,
    PAGE.margins.left, doc.page.height - 38,
    { width: CONTENT_WIDTH, align: 'center' },
  );
}

doc.end();
console.log(`Wrote ${outputPath}`);
