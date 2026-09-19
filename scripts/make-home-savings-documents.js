#!/usr/bin/env node
// Generates the bills a live /home-savings test needs, with KNOWN answers.
//
// Same purpose as make-test-documents.js does for /closing: the offline suites
// run against hand-written extractions, so they agree with the extractor by
// construction. Only a real document tests whether it reads one.
//
// Every figure below is chosen so the correct result is known in advance, and
// several are chosen as TRAPS — lines that look exactly like findings and must
// not become findings. The whole point of the classifier is that it refuses
// those, so a live run has to be asked whether it did.
//
//   node scripts/make-home-savings-documents.js [outdir]

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const OUT = process.argv[2] || path.join(__dirname, '..', 'tmp-home-savings-docs');
fs.mkdirSync(OUT, { recursive: true });

function write(name, build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
    const file = path.join(OUT, name);
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    build(doc);
    doc.end();
    stream.on('finish', () => resolve(file));
    stream.on('error', reject);
  });
}

function row(doc, label, amount) {
  const y = doc.y;
  doc.fontSize(10).text(label, 60, y, { width: 340 });
  doc.text(amount, 400, y, { width: 110, align: 'right' });
  doc.moveDown(0.35);
}

function rule(doc) {
  doc.moveTo(60, doc.y).lineTo(510, doc.y).strokeColor('#cccccc').stroke();
  doc.moveDown(0.5);
}

/* ---------------------------------------------------------------- bill 1

   Xfinity internet. Plants:
     H1  Equipment Rental - Gateway  $15.00/mo  ->  $180.00/yr CONFIRMED
     H2  promotional rate ends 2026-12-01, standard $104.00
           -> exposure $180.00/yr, NEVER a saving
     H4  Inside Wire Maintenance $5.99 -> a QUESTION, never a finding,
           because the customer does not name it in the form
     H6  no autopay discount line -> at_risk question, no figure
   TRAP: Broadcast TV Fee $6.01 and Regional Sports Fee $3.00 look exactly
   like optional extras and are mandatory. Neither may be raised as droppable.
   TRAP: Equipment Return Credit -$4.00 contains the word "equipment" and is
   money in the customer's favour.
   -------------------------------------------------------------------- */
const xfinity = (doc) => {
  doc.fontSize(18).text('XFINITY', 48, 48);
  doc.fontSize(9).text('Comcast Cable Communications', 48, 70);
  doc.fontSize(9).text('Statement date: September 5, 2026', 48, 84);
  doc.fontSize(9).text('Account 8497 10 021 3345771', 48, 98);
  doc.moveDown(2);

  doc.fontSize(13).text('Your bill at a glance', 48, 130);
  doc.moveDown(0.5);
  doc.fontSize(10).text('Previous balance', 60, doc.y);
  doc.fontSize(10).text('$74.00', 400, doc.y - 12, { width: 110, align: 'right' });
  doc.moveDown(0.4);
  doc.fontSize(10).text('Total due September 28, 2026', 60, doc.y);
  doc.fontSize(12).text('$89.00', 400, doc.y - 14, { width: 110, align: 'right' });
  doc.moveDown(1.2);

  doc.fontSize(13).text('Charges this period', 48, doc.y);
  doc.moveDown(0.5);
  rule(doc);
  row(doc, 'Performance Pro 400 Mbps Internet', '$62.00');
  row(doc, 'Equipment Rental - Wireless Gateway', '$15.00');
  row(doc, 'Inside Wire Maintenance Plan', '$5.99');
  row(doc, 'Broadcast TV Fee', '$6.01');
  row(doc, 'Regional Sports Fee', '$3.00');
  row(doc, 'Equipment Return Credit', '-$4.00');
  row(doc, 'Federal Universal Service Fund', '$1.00');
  rule(doc);
  row(doc, 'Total', '$89.00');

  doc.moveDown(1.5);
  doc.fontSize(9).fillColor('#444444').text(
    'Your promotional rate ends on 12/01/2026. After that date your monthly '
    + 'charge for this package will be $104.00.', 48, doc.y, { width: 460 });
  doc.moveDown(0.8);
  doc.text('Enroll in automatic payments and paperless billing to see if you qualify '
    + 'for additional savings.', 48, doc.y, { width: 460 });
};

/* ---------------------------------------------------------------- bill 2

   Verizon wireless. Plants:
     H3  Device Payment Agreement $27.08/mo, printed "Payment 24 of 24"
           -> the agreement is COMPLETE and still billing
           -> $324.96/yr CONFIRMED, with nobody having to remember it
     H6  Autopay Discount present -> check runs and PASSES, no finding
     H4  Device Protection $17.00 -> a QUESTION, never a finding
   TRAP: Federal Universal Service and Regulatory Recovery are pass-through.
   -------------------------------------------------------------------- */
const verizon = (doc) => {
  doc.fontSize(18).text('verizon', 48, 48);
  doc.fontSize(9).text('Wireless statement', 48, 70);
  doc.fontSize(9).text('Bill date: September 3, 2026', 48, 84);
  doc.fontSize(9).text('Account 942671553-00001', 48, 98);
  doc.moveDown(2);

  doc.fontSize(13).text('Account summary', 48, 130);
  doc.moveDown(0.5);
  doc.fontSize(10).text('Total due by September 27, 2026', 60, doc.y);
  doc.fontSize(12).text('$120.00', 400, doc.y - 14, { width: 110, align: 'right' });
  doc.moveDown(1.2);

  doc.fontSize(13).text('Charges', 48, doc.y);
  doc.moveDown(0.5);
  rule(doc);
  row(doc, 'Unlimited Plus Plan - 1 line', '$70.00');
  row(doc, 'Device Payment Agreement - iPhone', '$27.08');
  row(doc, 'Device Protection', '$17.00');
  row(doc, 'Autopay and Paper-free Billing Discount', '-$10.00');
  row(doc, 'Federal Universal Service Charge', '$2.42');
  row(doc, 'Regulatory Recovery Fee', '$1.50');
  row(doc, 'State and Local Taxes', '$12.00');
  rule(doc);
  row(doc, 'Total', '$120.00');

  doc.moveDown(1.5);
  doc.fontSize(13).text('Device payment detail', 48, doc.y);
  doc.moveDown(0.5);
  doc.fontSize(10).text('iPhone 15 Pro 256GB', 60, doc.y);
  doc.moveDown(0.3);
  doc.fontSize(10).text('Payment 24 of 24', 60, doc.y);
  doc.moveDown(0.3);
  doc.fontSize(10).text('Agreement balance: $0.00', 60, doc.y);
  doc.moveDown(0.3);
  doc.fontSize(10).text('Monthly device charge: $27.08', 60, doc.y);
};

(async () => {
  const a = await write('xfinity-internet-sept-2026.pdf', xfinity);
  const b = await write('verizon-wireless-sept-2026.pdf', verizon);
  console.log('Wrote:');
  console.log(' ', a);
  console.log(' ', b);
  console.log('');
  console.log('GROUND TRUTH — what a correct run must produce:');
  console.log('  H1 Xfinity gateway rental .......... $180.00/yr  CONFIRMED');
  console.log('  H3 Verizon device, "24 of 24" ...... $324.96/yr  CONFIRMED');
  console.log('  -> confirmedAnnual ................. $504.96');
  console.log('  H2 Xfinity promo ends 2026-12-01 ... $180.00/yr  AT RISK, never counted');
  console.log('  H6 Xfinity: no autopay discount .... question, NO figure');
  console.log('  H6 Verizon: autopay present ........ check ran and PASSED');
  console.log('');
  console.log('  QUESTIONS (never findings, never in a total):');
  console.log('    Inside Wire Maintenance Plan  $5.99');
  console.log('    Device Protection             $17.00');
  console.log('');
  console.log('  TRAPS — must NOT appear as droppable anywhere:');
  console.log('    Broadcast TV Fee              $6.01   (mandatory)');
  console.log('    Regional Sports Fee           $3.00   (mandatory)');
  console.log('    Equipment Return Credit      -$4.00   (a credit)');
  console.log('    Federal Universal Service / Regulatory Recovery / taxes');
})();
