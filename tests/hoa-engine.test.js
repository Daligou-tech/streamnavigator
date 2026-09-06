// Tests for api/_lib/hoa-engine.js.
//
// The thing worth protecting here is the citation trust guarantee. The HOA
// product page promises "Every finding cites the page it came from", and
// the engine only actually honours that because page numbers are copied
// out of citations the API generated from the source document — never read
// from anything the model wrote into a tool call. These tests pin that
// down: that citations are harvested from the response, that an evidence
// index the model invented is dropped rather than rendered, and that
// evidence_ids never survive into a stored report.
//
// Mocks both Supabase and @anthropic-ai/sdk through Module._load, so this
// touches no network, no database, and no API key, costs nothing to run,
// and works before `npm install` has fetched the SDK. The live end-to-end
// check is the separate, deliberately manual api/generate-hoa-report.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const hoaEnginePath = require.resolve('../api/_lib/hoa-engine');
const supabaseAdminPath = require.resolve('../api/_lib/supabaseAdmin');

// ---------------------------------------------------------------------------
// Module interception
// ---------------------------------------------------------------------------

const originalLoad = Module._load;
let sdkStub = null;

Module._load = function (request, parent, isMain) {
  if (request === '@anthropic-ai/sdk' && sdkStub) return sdkStub;
  return originalLoad.apply(this, arguments);
};

// A minimal stand-in for the SDK surface the engine actually uses:
// new Anthropic({apiKey}), client.files.upload/delete, and
// client.messages.stream(req).finalMessage().
function makeSdkStub({ responses, calls, uploads, deletes }) {
  class FakeAnthropic {
    constructor() {
      this.files = {
        upload: async ({ file }) => {
          const id = `file_${uploads.length}`;
          uploads.push({ id, file });
          return { id };
        },
        delete: async (id) => {
          deletes.push(id);
          return { id, deleted: true };
        },
      };
      this.messages = {
        stream: (request) => {
          calls.push(request);
          const response = responses[calls.length - 1];
          if (!response) throw new Error(`No stubbed response for call ${calls.length}`);
          // An Error in the response list is thrown from the API call, which
          // is how the failure-classification tests reproduce a billing
          // refusal or a transient outage.
          if (response instanceof Error) return { finalMessage: async () => { throw response; } };
          return { finalMessage: async () => response };
        },
      };
    }
  }
  return {
    default: FakeAnthropic,
    toFile: async (buffer, filename, opts) => ({ buffer, filename, opts }),
  };
}

function loadEngine(stub) {
  sdkStub = stub;
  delete require.cache[hoaEnginePath];
  return require('../api/_lib/hoa-engine');
}

// Loaded with a stub present so the pure helpers are importable.
const engine = loadEngine(makeSdkStub({ responses: [], calls: [], uploads: [], deletes: [] }));
const { harvestCitations, attachCitations, formatEvidenceTable, displayName, REPORT_TOOL, RISK_LEVELS } = engine;

function citedBlock(text, citations) {
  return { type: 'text', text, citations };
}

function pageCitation(overrides) {
  return Object.assign({
    type: 'page_location',
    document_index: 0,
    document_title: 'Reserve Study 2026.pdf',
    start_page_number: 12,
    end_page_number: 12,
    cited_text: 'The association is 28% funded as of the study date.',
  }, overrides);
}

// ---------------------------------------------------------------------------
// harvestCitations
// ---------------------------------------------------------------------------

test('harvestCitations pulls page citations off text blocks', () => {
  const evidence = harvestCitations([
    { type: 'thinking', thinking: 'ignored' },
    citedBlock('Reserves are weak.', [pageCitation()]),
  ]);

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].document_title, 'Reserve Study 2026.pdf');
  assert.equal(evidence[0].page_start, 12);
  assert.equal(evidence[0].cited_text, 'The association is 28% funded as of the study date.');
});

test('harvestCitations deduplicates the same passage cited repeatedly', () => {
  const evidence = harvestCitations([
    citedBlock('Weak reserves.', [pageCitation()]),
    citedBlock('Which also drives assessment risk.', [pageCitation()]),
    citedBlock('And a separate point.', [pageCitation({ start_page_number: 40, end_page_number: 41, cited_text: 'Roof replacement is scheduled for 2027.' })]),
  ]);

  assert.equal(evidence.length, 2, 'the repeated passage should collapse to one entry');
  assert.equal(evidence[1].page_start, 40);
  assert.equal(evidence[1].page_end, 41);
});

test('harvestCitations ignores blocks with no citations and non-text blocks', () => {
  const evidence = harvestCitations([
    { type: 'text', text: 'Uncited prose.' },
    { type: 'tool_use', name: 'code_execution', input: {} },
    { type: 'text', text: 'Also uncited.', citations: [] },
  ]);
  assert.deepEqual(evidence, []);
});

// ---------------------------------------------------------------------------
// displayName
// ---------------------------------------------------------------------------

test('displayName strips the upload timestamp the customer should never see', () => {
  // The first production run rendered
  // "1788102669194-hoa_governing_docs_sample.pdf" under every quoted passage,
  // because the storage key was passed through as the document title.
  assert.equal(
    displayName('hoa/11460e6f/1788102669194-hoa_governing_docs_sample.pdf'),
    'hoa governing docs sample.pdf',
  );
});

test('displayName leaves an already-clean filename alone', () => {
  assert.equal(displayName('hoa/abc/Reserve Study 2026.pdf'), 'Reserve Study 2026.pdf');
  // A short leading number is part of the name, not an upload timestamp.
  assert.equal(displayName('hoa/abc/2026 Budget.pdf'), '2026 Budget.pdf');
});

// ---------------------------------------------------------------------------
// attachCitations — the trust guarantee
// ---------------------------------------------------------------------------

test('attachCitations resolves evidence_ids to the harvested citations', () => {
  const evidence = [
    { document_title: 'Budget.pdf', page_start: 3, page_end: 3, cited_text: 'Operating deficit of $41,000.' },
    { document_title: 'Minutes.pdf', page_start: 2, page_end: 2, cited_text: 'The board discussed a special assessment.' },
  ];
  const report = {
    findings: [
      { concern: 'Operating deficit', evidence_ids: [0] },
      { concern: 'Assessment discussed', evidence_ids: [1, 0] },
    ],
  };

  const { report: out, droppedCitationRefs } = attachCitations(report, evidence);

  assert.equal(droppedCitationRefs, 0);
  assert.equal(out.findings[0].citations[0].page_start, 3);
  assert.equal(out.findings[1].citations.length, 2);
  assert.equal(out.findings[1].citations[0].cited_text, 'The board discussed a special assessment.');
});

test('attachCitations drops an evidence index the model invented', () => {
  const evidence = [
    { document_title: 'Budget.pdf', page_start: 3, page_end: 3, cited_text: 'Operating deficit of $41,000.' },
  ];
  const report = {
    findings: [{ concern: 'Made-up citation', evidence_ids: [0, 7, 99] }],
  };

  const { report: out, droppedCitationRefs } = attachCitations(report, evidence);

  assert.equal(droppedCitationRefs, 2, 'both out-of-range indices should be dropped');
  assert.equal(out.findings[0].citations.length, 1);
  assert.equal(out.findings[0].citations[0].page_start, 3);
});

test('attachCitations strips evidence_ids everywhere so none reach the customer', () => {
  const evidence = [{ document_title: 'A.pdf', page_start: 1, page_end: 1, cited_text: 'x' }];
  const report = {
    short_term_risk: { likelihood: 'Likely', evidence_ids: [0] },
    mid_term_risk: { likelihood: 'Possible', evidence_ids: [] },
    reserve_health: { percent_funded: '28%', evidence_ids: [0] },
    findings: [{ concern: 'c', evidence_ids: [0] }],
  };

  const { report: out } = attachCitations(report, evidence);

  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('evidence_ids'), 'evidence_ids must not survive into the stored report');
  assert.equal(out.short_term_risk.citations.length, 1);
  assert.deepEqual(out.mid_term_risk.citations, []);
  assert.equal(out.reserve_health.citations[0].document_title, 'A.pdf');
});

// ---------------------------------------------------------------------------
// Pinpoint quotes — model-written, so only shown if verifiably in the source
// ---------------------------------------------------------------------------

test('a pinpoint that appears in the cited evidence is kept', () => {
  const evidence = [{
    document_title: 'Financials.pdf', page_start: 8, page_end: 8,
    cited_text: 'Vendor Name Invoice Date Description Amount\r\nLANDPLAN CONSULTING  02/14/2026  Land use study   22,365.62\r\n',
  }];
  const report = { findings: [{ concern: 'x', pinpoint: 'LANDPLAN CONSULTING  02/14/2026  Land use study   22,365.62', evidence_ids: [0] }] };

  const { report: out, unverifiedPinpoints } = attachCitations(report, evidence);

  assert.equal(unverifiedPinpoints, 0);
  assert.match(out.findings[0].pinpoint, /22,365\.62/);
});

test('a pinpoint the model paraphrased or invented is discarded', () => {
  const evidence = [{
    document_title: 'Financials.pdf', page_start: 8, page_end: 8,
    cited_text: 'LANDPLAN CONSULTING  02/14/2026  Land use study   22,365.62',
  }];
  const report = {
    findings: [{ concern: 'x', pinpoint: 'Paid $22,365.62 to a land-use consultant from reserves', evidence_ids: [0] }],
  };

  const { report: out, unverifiedPinpoints } = attachCitations(report, evidence);

  assert.equal(unverifiedPinpoints, 1);
  assert.equal(out.findings[0].pinpoint, '', 'an unverifiable quote must not reach the customer');
});

test('pinpoint matching tolerates the whitespace a PDF ledger row carries', () => {
  // Column padding and CRLF in the source must not reject a quote that is
  // genuinely present — that would discard almost every real citation.
  const evidence = [{
    document_title: 'Financials.pdf', page_start: 3, page_end: 3,
    cited_text: 'RESERVE   INCOME\r\n   Interest    income        4,182.19\r\n',
  }];
  const report = { findings: [{ concern: 'x', pinpoint: 'Interest income 4,182.19', evidence_ids: [0] }] };

  const { report: out, unverifiedPinpoints } = attachCitations(report, evidence);

  assert.equal(unverifiedPinpoints, 0);
  assert.equal(out.findings[0].pinpoint, 'Interest income 4,182.19');
});

test('a pinpoint is checked only against that finding’s own evidence', () => {
  const evidence = [
    { document_title: 'A.pdf', page_start: 1, page_end: 1, cited_text: 'roof replacement 410,000' },
    { document_title: 'B.pdf', page_start: 2, page_end: 2, cited_text: 'elevator modernization 95,000' },
  ];
  const report = {
    findings: [{ concern: 'roof', pinpoint: 'elevator modernization 95,000', evidence_ids: [0] }],
  };

  const { report: out, unverifiedPinpoints } = attachCitations(report, evidence);

  assert.equal(unverifiedPinpoints, 1, 'text from an uncited evidence item must not validate');
  assert.equal(out.findings[0].pinpoint, '');
});

// ---------------------------------------------------------------------------
// formatEvidenceTable
// ---------------------------------------------------------------------------

test('formatEvidenceTable numbers rows by array position', () => {
  // The indices the model sees must be exactly the indices attachCitations
  // resolves against, or every citation in the report points at the wrong
  // passage. This is the seam between the two passes.
  const evidence = [
    { document_title: 'A.pdf', page_start: 1, page_end: 1, cited_text: 'first' },
    { document_title: 'B.pdf', page_start: 5, page_end: 7, cited_text: 'second' },
  ];
  const table = formatEvidenceTable(evidence);

  assert.match(table, /\[0\] A\.pdf \(p\. 1\)/);
  assert.match(table, /\[1\] B\.pdf \(pp\. 5-7\)/);
});

test('formatEvidenceTable tells the model not to cite when nothing was captured', () => {
  const table = formatEvidenceTable([]);
  assert.match(table, /leave every evidence_ids array empty/);
});

// ---------------------------------------------------------------------------
// Schema invariants
// ---------------------------------------------------------------------------

test('REPORT_TOOL satisfies the strict-mode contract', () => {
  assert.equal(REPORT_TOOL.strict, true);

  // strict:true requires additionalProperties:false and every property
  // present in `required` — a property left out is a 400 at request time,
  // which would only surface in production.
  function checkObject(schema, path) {
    if (schema.type !== 'object') return;
    assert.equal(schema.additionalProperties, false, `${path} must set additionalProperties:false`);
    const props = Object.keys(schema.properties || {});
    const required = schema.required || [];
    assert.deepEqual(
      props.slice().sort(),
      required.slice().sort(),
      `${path}: every property must be listed in required`,
    );
    for (const [key, child] of Object.entries(schema.properties || {})) {
      checkObject(child, `${path}.${key}`);
      if (child.type === 'array' && child.items) checkObject(child.items, `${path}.${key}[]`);
    }
  }

  checkObject(REPORT_TOOL.input_schema, 'input_schema');
});

test('risk_score is a typed enum, not free text', () => {
  assert.deepEqual(REPORT_TOOL.input_schema.properties.risk_score.enum, RISK_LEVELS);
  assert.deepEqual(
    REPORT_TOOL.input_schema.properties.findings.items.properties.severity.enum,
    RISK_LEVELS,
  );
});

test('the report schema still carries the fields the generic renderer reads', () => {
  // navigator-status.html renders headline / headline_tag / summary /
  // key_numbers / sections / missing_or_uncertain / closing_*. The HOA
  // schema is a superset so that renderer keeps working untouched.
  const props = REPORT_TOOL.input_schema.properties;
  for (const field of ['headline', 'headline_tag', 'summary', 'key_numbers', 'sections', 'missing_or_uncertain', 'closing_title', 'closing_body']) {
    assert.ok(props[field], `generic renderer field "${field}" is missing from the HOA schema`);
  }
});

// ---------------------------------------------------------------------------
// generateHoaReport — the two-pass pipeline
// ---------------------------------------------------------------------------

function makeFakeAdmin({ submission, reportInserts, submissionUpdates }) {
  return {
    from(table) {
      if (table === 'navigator_submissions') {
        return {
          select() {
            return { eq() { return { single: async () => ({ data: { ...submission }, error: null }) }; } };
          },
          update(patch) {
            submissionUpdates.push(patch);
            Object.assign(submission, patch);
            return { eq: async () => ({ data: null, error: null }) };
          },
        };
      }
      if (table === 'navigator_reports') {
        return {
          insert: async (row) => { reportInserts.push(row); return { data: null, error: null }; },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    storage: {
      from() {
        return {
          download: async () => ({
            data: { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 fake').buffer },
            error: null,
          }),
        };
      },
    },
  };
}

// evidenceContents is one response per document, because the evidence pass is
// now staged per document — each runs in its own invocation with its own time
// budget, which is what removed the 800s wall.
function runPipeline({ reportToolInput, evidenceContents }) {
  const submission = {
    id: 'sub-1',
    product: 'hoa',
    status: 'paid',
    file_paths: ['uploads/reserve-study.pdf', 'uploads/minutes.pdf'],
    form_data: { address: '12 Example Ct' },
  };
  const reportInserts = [];
  const submissionUpdates = [];
  const calls = [];
  const uploads = [];
  const deletes = [];

  const responses = [
    // An Error entry is thrown from the API call rather than returned as a
    // response, so a test can reproduce a billing refusal or an outage.
    ...evidenceContents.map((content) => (
      content instanceof Error ? content : { stop_reason: 'end_turn', content }
    )),
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'submit_hoa_report', input: reportToolInput }],
    },
  ];

  const stub = makeSdkStub({ responses, calls, uploads, deletes });

  delete require.cache[supabaseAdminPath];
  require.cache[supabaseAdminPath] = {
    id: supabaseAdminPath,
    filename: supabaseAdminPath,
    loaded: true,
    exports: { getSupabaseAdmin: () => makeFakeAdmin({ submission, reportInserts, submissionUpdates }) },
  };

  const { generateHoaReport } = loadEngine(stub);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  return { generateHoaReport, calls, uploads, deletes, reportInserts, submissionUpdates, submission };
}

test('generateHoaReport reads each document separately, then synthesises', async () => {
  const ctx = runPipeline({
    evidenceContents: [
      // Document 1: the reserve study.
      [citedBlock('The association is badly underfunded.', [pageCitation()])],
      // Document 2: the minutes.
      [citedBlock('A roof replacement is coming.', [pageCitation({
        document_title: 'Minutes.pdf',
        document_index: 0,
        start_page_number: 4,
        end_page_number: 4,
        cited_text: 'Board reviewed roof bids; funding options include a special assessment.',
      })])],
    ],
    reportToolInput: {
      risk_score: 'High',
      findings: [
        // Index 1 is real; index 5 is invented and must be dropped.
        {
          concern: 'Roof unfunded',
          severity: 'High',
          detail: 'Bids reviewed, no funding in place.',
          pinpoint: 'funding options include a special assessment',
          evidence_ids: [1, 5],
        },
      ],
      short_term_risk: { likelihood: 'Likely', evidence_ids: [0] },
      headline: 'Reserves are thin and a roof is due.',
    },
  });

  const report = await ctx.generateHoaReport('sub-1');

  // Two documents means two evidence stages plus one synthesis stage.
  assert.equal(ctx.calls.length, 3);

  const [docPass1, docPass2, synthesis] = ctx.calls;

  // Each evidence stage carries exactly ONE document. This is the property
  // that removed the time ceiling: a package of any size never puts more than
  // one document through a single invocation.
  for (const pass of [docPass1, docPass2]) {
    const docBlocks = pass.messages[0].content.filter((b) => b.type === 'document');
    assert.equal(docBlocks.length, 1, 'one document per evidence stage');
    assert.deepEqual(docBlocks[0].citations, { enabled: true }, 'citations must be enabled or no page numbers exist to harvest');
    assert.equal(docBlocks[0].source.type, 'file');
    assert.ok(pass.tools.some((t) => t.type === 'code_execution_20260521'));
    assert.ok(!pass.tools.some((t) => t.name === 'submit_hoa_report'));
  }

  // Synthesis: no documents attached, which is why it is fast; the report
  // tool, never forced (forcing conflicts with thinking); and a calculator,
  // because the cross-document arithmetic happens here.
  assert.equal(typeof synthesis.messages[0].content, 'string', 'synthesis works from narratives, not documents');
  assert.ok(synthesis.tools.some((t) => t.name === 'submit_hoa_report'));
  assert.ok(synthesis.tools.some((t) => t.type === 'code_execution_20260521'));
  assert.deepEqual(synthesis.tool_choice, { type: 'auto' });
  assert.match(synthesis.messages[0].content, /EVIDENCE TABLE/);
  assert.match(synthesis.messages[0].content, /PER-DOCUMENT ANALYSES/);

  // The shipped finding carries the API's page number, and the invented
  // index is gone.
  assert.equal(report.findings[0].citations.length, 1);
  assert.equal(report.findings[0].citations[0].page_start, 4);
  assert.equal(report.findings[0].citations[0].document_title, 'Minutes.pdf');
  assert.ok(!JSON.stringify(report).includes('evidence_ids'));

  // The pinpoint is genuinely inside the cited passage, so it survives.
  assert.equal(report.findings[0].pinpoint, 'funding options include a special assessment');

  // Stored, marked complete, and the buyer's documents cleaned up.
  assert.equal(ctx.reportInserts.length, 1);
  assert.equal(ctx.reportInserts[0].product, 'hoa');
  assert.equal(ctx.reportInserts[0].model, 'claude-opus-5');
  assert.equal(ctx.submission.status, 'complete');
  assert.deepEqual(ctx.deletes.sort(), ctx.uploads.map((u) => u.id).sort());
});

test('each stage claims and then releases the job, so the next tick continues', async () => {
  // api/hoa-job.js cannot otherwise tell a submission waiting for its next
  // stage from one whose stage is running right now — both sit at
  // 'processing' with a recent updated_at. Keying off updated_at alone made a
  // two-document job idle for the full 20 minute stall window between
  // documents, which live testing caught.
  const ctx = runPipeline({
    evidenceContents: [
      [citedBlock('Doc one.', [pageCitation()])],
      [citedBlock('Doc two.', [pageCitation({ start_page_number: 2, end_page_number: 2, cited_text: 'second' })])],
    ],
    reportToolInput: { risk_score: 'Low', findings: [], headline: 'ok' },
  });

  await ctx.generateHoaReport('sub-1');

  const marks = ctx.submissionUpdates
    .filter((p) => Object.prototype.hasOwnProperty.call(p, 'job_running_since'))
    .map((p) => (p.job_running_since === null ? 'released' : 'claimed'));

  // claim -> release for each of the two documents, then claim -> complete.
  assert.deepEqual(marks.slice(0, 4), ['claimed', 'released', 'claimed', 'released']);
  assert.equal(ctx.submission.job_running_since, null, 'a finished job must not look in-flight');
  assert.equal(ctx.submission.job_state, null, 'job_state is cleared once the report exists');
  assert.equal(ctx.submission.status, 'complete');
});

test('a failed stage still deletes the document it uploaded', async () => {
  const ctx = runPipeline({
    evidenceContents: [[]], // first document yields no text -> throws
    reportToolInput: {},
  });

  await assert.rejects(ctx.generateHoaReport('sub-1'), /produced no analysis text/);

  // Only the first document was ever uploaded, and it was cleaned up.
  assert.equal(ctx.uploads.length, 1);
  assert.deepEqual(ctx.deletes, ctx.uploads.map((u) => u.id));
  assert.equal(ctx.submission.status, 'failed');
  assert.match(ctx.submission.error, /produced no analysis text/);
});

test('a failure keeps job_state so a retry resumes instead of restarting', async () => {
  // The whole point of staging: 10 minutes of completed document reads must
  // not be thrown away because the next call failed.
  const ctx = runPipeline({
    evidenceContents: [
      [citedBlock('Doc one read fine.', [pageCitation()])],
      [], // second document fails
    ],
    reportToolInput: {},
  });

  await assert.rejects(ctx.generateHoaReport('sub-1'), /produced no analysis text/);

  assert.equal(ctx.submission.status, 'failed');
  assert.ok(ctx.submission.job_state, 'job_state must survive a failure');
  assert.equal(ctx.submission.job_state.docIndex, 1, 'resumes at the document that failed');
  assert.equal(ctx.submission.job_state.parts.length, 1, 'the completed document is kept');
  assert.equal(ctx.submission.generation_attempts, 1);
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

const BILLING_ERROR = () => new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}');

test('a billing refusal pauses the job instead of failing it', async () => {
  // This is the real 2026-09-06 failure. Nothing was wrong with the
  // submission; the account had run out of credit. Treating it as the
  // submission's fault spent all three attempts on something no retry could
  // fix and then abandoned a customer's paid report.
  const ctx = runPipeline({ evidenceContents: [BILLING_ERROR()], reportToolInput: {} });

  await assert.rejects(ctx.generateHoaReport('sub-1'), /credit balance is too low/);

  assert.equal(ctx.submission.status, 'processing', 'still going to happen, so not "failed"');
  assert.ok(!ctx.submission.generation_attempts, 'a retry budget must not be spent on this');
  assert.ok(ctx.submission.job_state.paused_until, 'paused rather than abandoned');
  assert.equal(ctx.submission.job_state.paused_reason, 'billing');
  assert.ok(Date.parse(ctx.submission.job_state.paused_until) > Date.now(), 'paused into the future');
  assert.equal(ctx.submission.refund_state, undefined, 'nothing is owed back — the report is still coming');
});

test('a paused job clears its pause when the next stage is claimed', async () => {
  const ctx = runPipeline({
    evidenceContents: [
      BILLING_ERROR(),
      // The fixture has two documents, so the resumed run reads both.
      [citedBlock('Read on the retry.', [pageCitation()])],
      [citedBlock('Second document.', [pageCitation({ start_page_number: 2, end_page_number: 2, cited_text: 'second' })])],
    ],
    reportToolInput: { risk_score: 'Low', findings: [], headline: 'ok' },
  });

  await assert.rejects(ctx.generateHoaReport('sub-1'));
  assert.ok(ctx.submission.job_state.paused_until);

  // Credit restored; the worker picks it up again.
  await ctx.generateHoaReport('sub-1');

  assert.equal(ctx.submission.status, 'complete');
  assert.equal(ctx.submission.job_state, null, 'a finished job carries no stale pause');
});

test('an ordinary failure spends an attempt, and does not owe a refund yet', async () => {
  const ctx = runPipeline({ evidenceContents: [new Error('overloaded_error')], reportToolInput: {} });

  await assert.rejects(ctx.generateHoaReport('sub-1'), /overloaded/);

  assert.equal(ctx.submission.status, 'failed');
  assert.equal(ctx.submission.generation_attempts, 1);
  assert.equal(ctx.submission.refund_state, undefined, 'two attempts remain — nothing is owed yet');
});

test('exhausting every attempt on a PAID submission queues a refund', async () => {
  const ctx = runPipeline({ evidenceContents: [new Error('overloaded_error')], reportToolInput: {} });
  ctx.submission.generation_attempts = 2; // one attempt left
  ctx.submission.stripe_checkout_session_id = 'cs_test_123';

  await assert.rejects(ctx.generateHoaReport('sub-1'));

  assert.equal(ctx.submission.generation_attempts, 3);
  assert.equal(ctx.submission.refund_state, 'due', 'paid and undeliverable means the money goes back');
});

test('a free scorecard row is never marked for refund', async () => {
  // Scorecard submissions have no checkout session. Marking one refund-due
  // would queue a refund for a payment that never happened.
  const ctx = runPipeline({ evidenceContents: [new Error('overloaded_error')], reportToolInput: {} });
  ctx.submission.generation_attempts = 2;
  ctx.submission.stripe_checkout_session_id = null;

  await assert.rejects(ctx.generateHoaReport('sub-1'));

  assert.equal(ctx.submission.generation_attempts, 3);
  assert.equal(ctx.submission.refund_state, undefined);
});

test('generateHoaReport refuses a submission with no documents', async () => {
  const ctx = runPipeline({ evidenceContents: [], reportToolInput: {} });
  ctx.submission.file_paths = [];

  await assert.rejects(ctx.generateHoaReport('sub-1'), /requires at least one uploaded document/);
  assert.equal(ctx.submission.status, 'failed');
});

test.after(() => { Module._load = originalLoad; });
