// Builds a plain, readable PDF version of a completed Navigator report —
// the same generic shape api/_lib/navigator-engine.js and
// api/_lib/purchase-engine.js both already produce (headline, summary,
// key_numbers, sections, missing_or_uncertain), the exact shape
// navigator-status.html renders in the browser. Added 2026-09-01 so a
// customer can get a copy emailed to them instead of only ever viewing it
// on that one page/device.
//
// Uses pdfkit (pure JavaScript, no native dependencies — safe in Vercel's
// serverless environment) rather than a headless-browser HTML-to-PDF
// approach, which would be much heavier for a plain, text-focused document
// like this one.

const PDFDocument = require('pdfkit');

const COLORS = {
  heading: '#1F1B16',
  body: '#3A342B',
  muted: '#7A7163',
  accent: '#4FB6E8',
};

// Sets the font explicitly, not just the colour and size. pdfkit carries the
// last font forward, so with the headline set in Helvetica-Bold every following
// body paragraph -- the summary, every section item, every line under "What we
// couldn't verify" -- rendered bold, i.e. the whole report. Caught by rasterising
// a generated PDF and looking at it. Anything that wants bold sets it itself.
function addWrappedText(doc, text, options) {
  doc.fillColor(COLORS.body).fontSize(11).font('Helvetica').text(text, options);
}

// The drafted letters, in a fixed order, as a plain list.
//
// Either one can be absent — a finding is routed to the lender or to the
// settlement agent by the check that produced it, and a clean document produces
// neither. Absent is a normal result, not a failure, so this returns an empty
// array and every caller below simply prints nothing.
function collectLetters(report) {
  const emails = report && report.emails;
  if (!emails) return [];
  const out = [];
  if (emails.lender) out.push({ who: 'Lender', email: emails.lender });
  if (emails.settlement) out.push({ who: 'Settlement agent', email: emails.settlement });
  return out;
}

// Returns a Promise<Buffer> — pdfkit is a stream-based API, so this
// collects the generated chunks itself rather than exposing a stream to
// every caller.
function buildReportPdfBuffer(report, meta) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 56, size: 'LETTER' });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fillColor(COLORS.accent).fontSize(10).text('STREAMNAVIGATOR', { characterSpacing: 1.5 });
      doc.moveDown(0.3);
      doc.fillColor(COLORS.heading).fontSize(18).font('Helvetica-Bold').text(report.headline || 'Your report', { width: 500 });
      if (report.headline_tag) {
        doc.moveDown(0.2);
        doc.fillColor(COLORS.accent).fontSize(10).font('Helvetica-Bold').text(String(report.headline_tag).toUpperCase());
      }
      doc.moveDown(0.6);

      if (report.summary) {
        addWrappedText(doc, report.summary, { width: 500 });
        doc.moveDown(1);
      }

      // Sign-post, printed before the findings rather than after them.
      // A customer who reads three pages of findings and stops has still got
      // the letters — but only if they were told, up front, that they exist.
      const letters = collectLetters(report);
      if (letters.length) {
        doc.fillColor(COLORS.accent).fontSize(11).font('Helvetica-Bold').text(
          letters.length === 1
            ? 'A ready-to-send letter is at the back of this report.'
            : 'Two ready-to-send letters are at the back of this report.',
          { width: 500 }
        );
        doc.moveDown(0.25);
        doc.fillColor(COLORS.muted).fontSize(10).font('Helvetica').text(
          letters.length === 1
            ? `Addressed to your ${letters[0].who.toLowerCase()}, covering the findings below. Check every figure against your own documents before you send it.`
            : 'One for your lender and one for your settlement agent, covering the findings below. Check every figure against your own documents before you send them.',
          { width: 500 }
        );
        doc.moveDown(1);
      }

      // Key numbers, as a simple two-column list rather than trying to
      // replicate the card-grid layout from the web page — a PDF is read
      // linearly, not scanned the way a webpage grid is.
      if (Array.isArray(report.key_numbers) && report.key_numbers.length) {
        doc.fillColor(COLORS.heading).fontSize(13).font('Helvetica-Bold').text('Key numbers');
        doc.moveDown(0.3);
        report.key_numbers.forEach((n) => {
          doc.fillColor(COLORS.muted).fontSize(10).font('Helvetica-Bold').text(String(n.label || ''), { continued: false });
          doc.fillColor(COLORS.body).fontSize(11).font('Helvetica').text(String(n.value || ''));
          doc.moveDown(0.3);
        });
        doc.moveDown(0.5);
      }

      // Sections
      (report.sections || []).forEach((section) => {
        if (doc.y > 680) doc.addPage();
        // pdfkit's built-in Helvetica font has no emoji glyphs — the
        // section icons (💰, 🏦, etc.) rendered as garbage characters when
        // included directly, caught by actually rendering a sample PDF to
        // an image and looking at it rather than just checking the byte
        // count. Titles alone read perfectly fine without the icon.
        const title = section.title || '';
        doc.fillColor(COLORS.heading).fontSize(13).font('Helvetica-Bold').text(title, { width: 500 });
        doc.moveDown(0.25);
        (section.items || []).forEach((item) => {
          addWrappedText(doc, String(item), { width: 500 });
          doc.moveDown(0.3);
        });
        doc.moveDown(0.4);
      });

      if (Array.isArray(report.missing_or_uncertain) && report.missing_or_uncertain.length) {
        if (doc.y > 650) doc.addPage();
        doc.fillColor(COLORS.heading).fontSize(13).font('Helvetica-Bold').text('What we couldn\'t verify');
        doc.moveDown(0.25);
        report.missing_or_uncertain.forEach((item) => {
          addWrappedText(doc, `•  ${item}`, { width: 500 });
          doc.moveDown(0.25);
        });

        // Surface-specific: a PDF has no input box, so it points at the place
        // that does rather than telling the reader to type something here.
        doc.moveDown(0.25);
        addWrappedText(
          doc,
          'Any figures we could not read can be entered on your online report, and we will rebuild it with them included.',
          { width: 500 }
        );
      }

      // The letters. Last, on their own page, because this is the part the
      // customer acts on and has to be able to find without hunting — and
      // because a letter split across a page break by a stray heading reads
      // like two half-letters.
      if (letters.length) {
        doc.addPage();
        doc.fillColor(COLORS.accent).fontSize(10).font('Helvetica-Bold').text(
          letters.length === 1 ? 'READY-TO-SEND LETTER' : 'READY-TO-SEND LETTERS',
          { characterSpacing: 1.5 }
        );
        doc.moveDown(0.4);
        doc.fillColor(COLORS.body).fontSize(11).font('Helvetica').text(
          'Copy the text below into an email. Read it first: check every figure against '
          + 'your own documents, add anything you know that we could not see, and delete '
          + 'anything you would rather not raise. This is your letter, sent under your '
          + 'name — we are not a party to it.',
          { width: 500 }
        );
        doc.moveDown(1);

        letters.forEach((entry, index) => {
          // 560 is the practical floor for starting a letter: a heading plus
          // the To/Subject block plus one line of body. Below that the header
          // strands at the bottom of a page with the letter overleaf.
          if (index > 0 || doc.y > 560) doc.addPage();

          doc.fillColor(COLORS.heading).fontSize(13).font('Helvetica-Bold')
            .text(`Letter ${index + 1} of ${letters.length} — to your ${entry.who.toLowerCase()}`, { width: 500 });
          doc.moveDown(0.5);

          // `to` is the party's name where the extraction captured one. It is
          // routinely null — the settlement agent's name is not among the
          // fields read — so the label is only printed when there is a name to
          // put after it, never as an empty "To:".
          if (entry.email.to) {
            doc.fillColor(COLORS.muted).fontSize(10).font('Helvetica-Bold').text('To');
            doc.fillColor(COLORS.body).fontSize(11).font('Helvetica').text(String(entry.email.to), { width: 500 });
            doc.moveDown(0.3);
          }

          doc.fillColor(COLORS.muted).fontSize(10).font('Helvetica-Bold').text('Subject');
          doc.fillColor(COLORS.body).fontSize(11).font('Helvetica').text(String(entry.email.subject || ''), { width: 500 });
          doc.moveDown(0.6);

          // Printed line by line rather than as one block: the body carries its
          // own paragraph breaks and numbered items, and handing the whole
          // string to pdfkit at once collapses them into a wall of text.
          String(entry.email.body || '').split('\n').forEach((line) => {
            if (doc.y > 700) doc.addPage();
            if (line.trim() === '') {
              doc.moveDown(0.5);
              return;
            }
            doc.fillColor(COLORS.body).fontSize(11).font('Helvetica').text(line, { width: 500 });
          });

          doc.moveDown(1);
        });
      }

      // Footer — checked against remaining space first so a two-line
      // footer can't get split with one line stranded on an otherwise
      // blank extra page (caught by rendering this to an image and
      // actually looking, not just checking that a PDF came out).
      if (doc.y > 700) doc.addPage();
      doc.moveDown(1);
      doc.fillColor(COLORS.muted).fontSize(8).font('Helvetica').text(
        `Generated by StreamNavigator${meta && meta.generatedAt ? ' on ' + meta.generatedAt : ''}. This analysis is directional, not financial advice — see the full report online for sourcing details.`,
        { width: 500 }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildReportPdfBuffer };
