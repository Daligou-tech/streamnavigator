// Tests for api/_lib/purchase-engine.js: the guarantee that a paid Purchase
// Navigator report always contains all six promised sections (never a
// silent omission), that a model response missing one gets retried, and
// that a web_search-tool failure falls back to a knowledge-only call
// instead of failing the whole report. Mocks global.fetch (the Anthropic
// call) and Supabase (via the require-cache trick also used in
// tests/navigator-intake-buying.test.js) so none of this touches the
// network or a real database — and costs nothing to run.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const supabaseAdminPath = require.resolve('../api/_lib/supabaseAdmin');
const purchaseEnginePath = require.resolve('../api/_lib/purchase-engine');

function makeFakeAdmin({ submission, reportInserts, submissionUpdates }) {
  return {
    from(table) {
      if (table === 'navigator_submissions') {
        return {
          select() {
            return {
              eq() {
                return {
                  // Returns the CURRENT (mutated) state, not a frozen
                  // snapshot — generatePurchaseReport is now called once per
                  // attempt (see purchase-engine.js), and each call must see
                  // the generation_attempts / status left by the previous
                  // one, the same way separate polls would in production.
                  single: async () => ({ data: { ...submission }, error: null }),
                };
              },
            };
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
          insert: async (row) => {
            reportInserts.push(row);
            return { data: row, error: null };
          },
        };
      }
      throw new Error(`Unexpected table in test: ${table}`);
    },
    storage: {
      from() {
        return { download: async () => ({ data: null, error: new Error('no files in this test') }) };
      },
    },
  };
}

function installFakes({ submission }) {
  const reportInserts = [];
  const submissionUpdates = [];
  const fakeAdmin = makeFakeAdmin({ submission, reportInserts, submissionUpdates });

  const fakeModule = new Module(supabaseAdminPath);
  fakeModule.exports = { getSupabaseAdmin: () => fakeAdmin };
  fakeModule.loaded = true;
  require.cache[supabaseAdminPath] = fakeModule;

  delete require.cache[purchaseEnginePath];

  return { reportInserts, submissionUpdates };
}

function uninstallFakes() {
  delete require.cache[supabaseAdminPath];
  delete require.cache[purchaseEnginePath];
}

function fakeSubmission(overrides) {
  return {
    id: 'sub-1',
    product: 'buying',
    file_paths: [],
    form_data: {
      category: 'appliance',
      item_description: 'LG 33-inch French door refrigerator',
      price_value: '2400',
      financing: 'cash',
      ownership_years: '8',
      location: '30301',
      timeline: 'this_month',
      size_constraints: '33-inch opening',
      configuration: 'French door',
    },
    ...overrides,
  };
}

function completeReportInput(overrides) {
  return {
    headline: 'A solid buy at $2,400 — total cost around $2,900 over 8 years',
    headline_tag: 'Buy',
    summary: 'This fridge is reasonably priced and the running costs are typical for its size.',
    research_notes: ['Comparable 33-inch French door fridges list for $1,800-$2,600 at major retailers.'],
    // The model gives line items and a per-year running cost; it is never
    // asked for a total. $55-$70/yr over 8 years is $440-$560, which is
    // exactly what the running line says — that agreement is what
    // tcoArithmeticProblem checks, and several tests below break it on
    // purpose.
    total_cost_of_ownership: {
      time_horizon_years: 8,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'the quoted price' },
        { label: 'Electricity', kind: 'running', low: 440, high: 560, basis: '$55-$70/yr at typical U.S. rates' },
        { label: 'Delivery and haul-away', kind: 'other', low: 100, high: 150, basis: 'typical retailer fee' },
      ],
      explanation: 'Purchase price plus roughly $400-$500 in electricity over 8 years.',
    },
    financing_impact: { applicable: false, explanation: 'Paying cash, so there is no financing cost — the $2,400 price is the full cost.' },
    maintenance_running_costs: { annual_low: 55, annual_high: 70, explanation: 'Typical electricity draw for a French door fridge this size, plus occasional minor repairs.' },
    depreciation_resale: { expected_resale_note: 'No meaningful resale market for appliances', explanation: 'Refrigerators are not typically resold for meaningful value; treat this as a sunk cost over its useful life.' },
    alternative_comparison: { alternative_name: 'A comparable top-freezer model, ~$1,600', explanation: 'A simpler top-freezer configuration would cost several hundred dollars less with slightly higher energy use, but no ice/water dispenser.' },
    recommendation: { verdict: 'buy', reasoning: 'Price is in the typical range and the customer already needs a replacement — no reason to wait.' },
    assumptions: [
      'Assumed a typical U.S. average electricity rate of about $0.16/kWh since no exact rate was given.',
      'Assumed roughly 550 kWh a year of draw, typical for a 33-inch French door model.',
      'Assumed no extended warranty is purchased.',
    ],
    missing_or_uncertain: [],
    ...overrides,
  };
}

function toolUseResponse(input) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'tool_use', name: 'submit_purchase_report', input }] }),
  };
}

// The engine makes two different kinds of call. A full attempt asks for
// submit_purchase_report; a targeted field repair asks for submit_field_repair
// behind a forced tool_choice, so it can refill one empty explanation without
// spending a whole retry. A fake that answers every request with a
// submit_purchase_report block starves the repair path: repairExplanationField
// finds no submit_field_repair block, logs, returns null, and the attempt falls
// through to a full retry. These helpers route on the requested tool the way
// the real API would, so a test can decide whether the repair succeeds.
function requestedTool(opts) {
  const body = JSON.parse((opts && opts.body) || '{}');
  return (body.tool_choice && body.tool_choice.name) || null;
}

// Three different repairs now share the tool name submit_field_repair —
// prose, cost model, assumptions — so a fake that wants to answer one of
// them specifically has to look at the schema it was handed.
function repairKind(opts) {
  const body = JSON.parse((opts && opts.body) || '{}');
  const tool = (body.tools || [])[0];
  const props = (tool && tool.input_schema && tool.input_schema.properties) || {};
  if (props.cost_breakdown) return 'cost_model';
  if (props.assumptions) return 'assumptions';
  if (props.value) return 'prose';
  return null;
}

// A response carrying the server-side record of searches actually run,
// which is what countSearchRounds reads.
function searchedToolUseResponse(input, rounds) {
  const content = [];
  for (let i = 0; i < rounds; i++) content.push({ type: 'server_tool_use', name: 'web_search', id: 'srvtoolu_' + i, input: { query: 'q' + i } });
  content.push({ type: 'tool_use', name: 'submit_purchase_report', input });
  return {
    ok: true,
    json: async () => ({ content, usage: { server_tool_use: { web_search_requests: rounds } } }),
  };
}

function fieldRepairResponse(value) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'tool_use', name: 'submit_field_repair', input: { value } }] }),
  };
}

test('a complete first response produces a report with all six sections and marks the submission complete', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => toolUseResponse(completeReportInput());
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  const sectionTitles = report.sections.map((s) => s.title);
  assert.match(sectionTitles[0], /total cost of ownership/i);
  assert.match(sectionTitles[1], /financing/i);
  assert.match(sectionTitles[2], /maintenance/i);
  assert.match(sectionTitles[3], /depreciation/i);
  assert.match(sectionTitles[4], /compares/i);
  assert.match(sectionTitles[5], /recommendation/i);
  report.sections.slice(0, 6).forEach((s) => {
    assert.ok(s.items.length > 0 && s.items[0].length > 0, `section "${s.title}" must not be empty`);
  });

  assert.equal(reportInserts.length, 1);
  assert.equal(reportInserts[0].product, 'buying');
  assert.ok(submissionUpdates.some((u) => u.status === 'processing'));
  assert.ok(submissionUpdates.some((u) => u.status === 'complete'));
  assert.ok(!submissionUpdates.some((u) => u.status === 'failed'));
});

test('a response missing a required section (financing_impact.explanation) hands back to "paid" instead of retrying inside one call, and a second call recovers', async (t) => {
  // Regression test for a real production incident: two full attempts
  // stacked inside a single generatePurchaseReport call could exceed
  // Vercel's 60s Hobby-plan function limit and get hard-killed mid-flight,
  // leaving the row stuck at status:'processing' forever with no failure
  // message. The fix makes each call attempt exactly once and, on a
  // recoverable failure, sets status back to 'paid' so the next poll (a
  // separate invocation, with its own full time budget) tries again — this
  // test drives that as two separate generatePurchaseReport('sub-1') calls,
  // the way two separate polls actually would.
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let call = 0;
  let mainCalls = 0;
  global.fetch = async (url, opts) => {
    call++;
    if (requestedTool(opts) === 'submit_field_repair') {
      // An empty repair is a failed repair: the engine stops the repair loop
      // and falls through to the hand-back path this test is about. Without
      // this branch the fake answers the repair with a submit_purchase_report
      // block, which fails for the wrong reason and hides what is being tested.
      return fieldRepairResponse('');
    }
    mainCalls++;
    if (mainCalls === 1) {
      const bad = completeReportInput({ financing_impact: { applicable: false, explanation: '' } });
      return toolUseResponse(bad);
    }
    return toolUseResponse(completeReportInput());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');

  const firstResult = await generatePurchaseReport('sub-1');
  assert.equal(firstResult, null, 'a recoverable failure with attempts remaining must not throw or return a report');
  assert.equal(submission.status, 'paid', 'must hand back to "paid" so the next poll retries, not stay stuck at "processing"');
  assert.equal(submission.generation_attempts, 1);
  assert.equal(reportInserts.length, 0);

  const report = await generatePurchaseReport('sub-1');

  assert.equal(mainCalls, 2, 'expected exactly one full Anthropic attempt per generatePurchaseReport invocation');
  assert.equal(call, 3, 'two full attempts plus the one targeted field-repair call the first attempt spent before giving up');
  assert.ok(report.sections[1].items[0].length > 0, 'financing section must be populated after the second attempt');
  assert.equal(reportInserts.length, 1);
  assert.equal(submission.generation_attempts, 2);
  assert.ok(submissionUpdates.some((u) => u.status === 'complete'));
});

test('a response missing every required section on every attempt marks the submission failed rather than storing a broken report', async (t) => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => toolUseResponse(completeReportInput({ recommendation: { verdict: 'buy', reasoning: '' } }));
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');

  // Drive exactly MAX_ATTEMPTS calls (whatever that's currently set to,
  // rather than hardcoding it — this bumped from 2 to 4 on 2026-08-31 and
  // a hardcoded loop count would have silently stopped testing exhaustion).
  for (let i = 1; i < __internal.MAX_ATTEMPTS; i++) {
    const result = await generatePurchaseReport('sub-1');
    assert.equal(result, null, `attempt ${i} with attempts remaining must hand back to "paid", not throw`);
    assert.equal(submission.status, 'paid');
  }
  await assert.rejects(() => generatePurchaseReport('sub-1'), 'the final attempt must throw once MAX_ATTEMPTS is reached');

  assert.equal(reportInserts.length, 0, 'an incomplete report must never be stored');
  assert.ok(submissionUpdates.some((u) => u.status === 'failed'));
  const failedUpdate = submissionUpdates.find((u) => u.status === 'failed');
  assert.ok(failedUpdate.error && failedUpdate.error.length > 0);
  assert.match(failedUpdate.error, /recommendation/, 'the failure message should name the actual empty field for diagnosability');
});

test('a submission that already exhausted MAX_ATTEMPTS is marked failed immediately without making another API call', async (t) => {
  // Guards against the stuck-processing recovery path in
  // get-navigator-submission.js re-triggering generation forever if every
  // single attempt times out — once attempts are used up, this must fail
  // fast rather than starting yet another attempt.
  const { __internal } = require('../api/_lib/purchase-engine');
  const submission = fakeSubmission({ generation_attempts: __internal.MAX_ATTEMPTS });
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => { callCount++; return toolUseResponse(completeReportInput()); };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  await assert.rejects(() => generatePurchaseReport('sub-1'));

  assert.equal(callCount, 0, 'must not call the Anthropic API once attempts are exhausted');
  assert.equal(reportInserts.length, 0);
  assert.ok(submissionUpdates.some((u) => u.status === 'failed'));
});

test('a leaked tool-syntax fragment attached to otherwise-real prose is stripped in place and the report succeeds on the first attempt', async (t) => {
  // Regression test for a real production incident (2026-08-31): a live
  // vehicle+financing submission leaked the literal text
  // `<parameter name="estimate_low">` into total_cost_of_ownership.explanation
  // on 2 separate real attempts, and the OLD behavior (reject outright) both
  // times exhausted MAX_ATTEMPTS and left the customer with nothing despite
  // having paid. The fix strips tag-like fragments instead of discarding the
  // whole report over them — this must resolve in ONE attempt, not two.
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = async () => {
    call++;
    const contaminated = completeReportInput({
      total_cost_of_ownership: {
        time_horizon_years: 8,
        cost_breakdown: [
          { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'the quoted price' },
          { label: 'Electricity', kind: 'running', low: 440, high: 560, basis: '$55-$70/yr at typical U.S. rates' },
          { label: 'Delivery and haul-away', kind: 'other', low: 100, high: 150, basis: 'typical retailer fee' },
        ],
        explanation: 'Purchase price plus roughly $400-$500 in electricity over 8 years, using the <parameter name="estimate_low"> baseline.',
      },
    });
    return toolUseResponse(contaminated);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(call, 1, 'a stray tag fragment must be repaired, not spent as a whole retry attempt');
  assert.equal(reportInserts.length, 1);
  assert.ok(submissionUpdates.some((u) => u.status === 'complete'));
  assert.equal(submission.generation_attempts, 1);
  const reportText = JSON.stringify(report);
  assert.ok(!reportText.includes('<parameter'), 'the stored report must not contain the leaked tag fragment');
  assert.ok(reportText.includes('roughly $400-$500 in electricity'), 'the real surrounding prose must survive the strip');
});

test('a leaked tag that is the entire content of a required field still triggers a retry (stripping correctly leaves it empty)', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let call = 0;
  let mainCalls = 0;
  global.fetch = async (url, opts) => {
    call++;
    if (requestedTool(opts) === 'submit_field_repair') return fieldRepairResponse('');
    mainCalls++;
    if (mainCalls === 1) {
      const bad = completeReportInput({
        financing_impact: { applicable: false, explanation: '<parameter name="estimate_low">' },
      });
      return toolUseResponse(bad);
    }
    return toolUseResponse(completeReportInput());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const firstResult = await generatePurchaseReport('sub-1');
  assert.equal(firstResult, null, 'stripping down to an empty required field must still hand back to "paid", not throw');
  assert.equal(submission.status, 'paid');

  const report = await generatePurchaseReport('sub-1');
  assert.equal(mainCalls, 2);
  assert.equal(call, 3, 'the stripped field is repairable in principle, so one repair call is attempted before the retry');
  assert.equal(reportInserts.length, 1);
  assert.ok(report.headline);
});

test('a repairable empty explanation is refilled in-call instead of spending a full retry', async (t) => {
  // The counterpart to the two tests above, and the reason their call counts
  // moved. When the targeted repair actually comes back with prose, the
  // attempt completes: no hand-back to "paid", no second poll, no extra
  // generation attempt burned on a report that was one field short.
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let mainCalls = 0;
  let repairCalls = 0;
  global.fetch = async (url, opts) => {
    if (requestedTool(opts) === 'submit_field_repair') {
      repairCalls++;
      return fieldRepairResponse('Paying cash, so the sticker price is the cost. There is no financing interest to add.');
    }
    mainCalls++;
    return toolUseResponse(completeReportInput({ financing_impact: { applicable: false, explanation: '' } }));
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.ok(report, 'a successful repair must complete the attempt rather than hand back');
  assert.equal(mainCalls, 1, 'the repair replaces a full retry — it must not trigger a second full attempt');
  assert.equal(repairCalls, 1);
  assert.equal(submission.generation_attempts, 1, 'a repaired attempt must not burn a second attempt');
  assert.equal(reportInserts.length, 1);
  assert.ok(report.sections[1].items[0].length > 0, 'the repaired financing explanation must reach the stored report');
  assert.ok(submissionUpdates.some((u) => u.status === 'complete'));
  assert.ok(!submissionUpdates.some((u) => u.status === 'paid'));
});

test('an unsupported web_search tool error steps down to the legacy variant before giving up on research', async (t) => {
  // The engine used to hold a single web_search version and drop straight
  // to knowledge-only when it was rejected. Since buying.html sells "live
  // web research", losing it is a downgrade of the product, so a rejection
  // of the current variant now tries the older one first.
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  const searchTypesTried = [];
  global.fetch = async (url, opts) => {
    const parsedBody = JSON.parse(opts.body);
    const search = (parsedBody.tools || []).find((tool) => String(tool.type || '').startsWith('web_search'));
    if (search) {
      searchTypesTried.push(search.type);
      return { ok: false, status: 400, text: async () => 'invalid_request_error: the web_search tool is not enabled for this API key' };
    }
    return toolUseResponse(completeReportInput());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport, __internal } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.deepEqual(
    searchTypesTried,
    [__internal.WEB_SEARCH_TOOL.type, __internal.WEB_SEARCH_TOOL_LEGACY.type],
    'must try the current variant, then the legacy one, before dropping search'
  );
  assert.equal(reportInserts.length, 1);
  assert.ok(report.headline);
});

test('the web_search tool is pinned to a version the report model actually supports', async () => {
  // The engine ran on claude-sonnet-5 with the tool pinned at
  // web_search_20250305 — the variant that predates that model. A paid
  // report on 2026-09-07 came back with zero searches and an empty
  // research_notes while the page told the customer it used live research.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.WEB_SEARCH_TOOL.type, 'web_search_20260209');
  assert.equal(__internal.WEB_SEARCH_TOOL_LEGACY.type, 'web_search_20250305');
  assert.notEqual(
    __internal.WEB_SEARCH_TOOL.type,
    __internal.WEB_SEARCH_TOOL_LEGACY.type,
    'the fallback must be a different version, or the step-down is a no-op'
  );
});

test('a model that only searches and summarizes in text (no tool_use on the first turn) gets one forced follow-up call', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let call = 0;
  global.fetch = async (url, opts) => {
    call++;
    if (call === 1) {
      // Model responded with a thinking block plus plain text, never
      // calling submit_purchase_report.
      return {
        ok: true,
        json: async () => ({
          content: [
            { type: 'thinking', thinking: 'Let me work through the math...' },
            { type: 'text', text: 'Here is what I found from searching...' },
          ],
        }),
      };
    }
    const parsedBody = JSON.parse(opts.body);
    assert.equal(parsedBody.tool_choice.type, 'tool', 'the forced follow-up must force the submit tool');
    assert.equal(parsedBody.thinking, undefined, 'the forced follow-up must not enable thinking — incompatible with a forced tool_choice');
    const replayedAssistantTurn = parsedBody.messages.find((m) => m.role === 'assistant');
    assert.ok(
      !replayedAssistantTurn.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'),
      'thinking blocks from the first turn must be stripped before replaying it into a request where thinking is off'
    );
    return toolUseResponse(completeReportInput());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(call, 2);
  assert.equal(reportInserts.length, 1);
  assert.ok(report.headline);
});

test('the first, non-forced call enables extended thinking as scratch space for the report\'s arithmetic', async (t) => {
  // Direct fix for the 2026-08-31 incident: the model reproducibly (7/7
  // live attempts) leaked a simulated tool-call fragment into
  // total_cost_of_ownership.explanation instead of just stating the
  // computed number — plausibly because it had nowhere else to "show its
  // work" for the financing/TCO arithmetic. Giving it a real thinking
  // channel is the structural fix; this locks in that the first call
  // actually requests it.
  const submission = fakeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let firstBody = null;
  global.fetch = async (url, opts) => {
    if (!firstBody) firstBody = JSON.parse(opts.body);
    return toolUseResponse(completeReportInput());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  await generatePurchaseReport('sub-1');

  assert.equal(firstBody.tool_choice.type, 'auto', 'thinking is only valid alongside a non-forced tool_choice');
  // Adaptive, not a fixed budget. ANTHROPIC_MODEL is claude-sonnet-5, and on
  // the Claude 5 models adaptive is the only way to turn thinking on — the
  // legacy thinking:{type:'enabled',budget_tokens:N} form is rejected there,
  // so this assertion is what stops a well-meaning revert to it.
  assert.equal(firstBody.thinking.type, 'adaptive');
  // effort belongs in a top-level output_config, not inside thinking. Putting
  // it in the wrong place is a 400, not a silent downgrade.
  assert.equal(firstBody.output_config.effort, 'high');
  assert.equal(firstBody.thinking.budget_tokens, undefined, 'budget_tokens alongside adaptive is rejected');
  assert.ok(firstBody.max_tokens > 4096, 'thinking and the final output share max_tokens — leave room for both');
});

test('__internal.isReportComplete rejects a report missing any one of the six required sections', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.isReportComplete(completeReportInput()), true);

  const cases = [
    { total_cost_of_ownership: { explanation: '' } },
    { financing_impact: { applicable: false, explanation: '' } },
    { maintenance_running_costs: { explanation: '' } },
    { depreciation_resale: { explanation: '' } },
    { alternative_comparison: { alternative_name: '', explanation: 'x' } },
    { recommendation: { verdict: 'buy', reasoning: '' } },
    { recommendation: { verdict: 'not-a-real-verdict', reasoning: 'x' } },
    { headline: '' },
    { summary: '   ' },
  ];
  cases.forEach((patch) => {
    const broken = completeReportInput(patch);
    assert.equal(__internal.isReportComplete(broken), false, `expected incomplete for patch ${JSON.stringify(patch)}`);
  });
});

test('__internal.firstIncompleteField names which specific field is missing, for diagnosable failure messages', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const cases = [
    [{ headline: '' }, 'headline'],
    [{ summary: '   ' }, 'summary'],
    [{ total_cost_of_ownership: { explanation: '' } }, 'total_cost_of_ownership.explanation'],
    [{ financing_impact: { applicable: false, explanation: '' } }, 'financing_impact.explanation'],
    [{ maintenance_running_costs: { explanation: '' } }, 'maintenance_running_costs.explanation'],
    [{ depreciation_resale: { explanation: '' } }, 'depreciation_resale.explanation'],
    [{ alternative_comparison: { alternative_name: '', explanation: 'x' } }, 'alternative_comparison'],
    [{ recommendation: { verdict: 'buy', reasoning: '' } }, 'recommendation'],
  ];
  cases.forEach(([patch, expectedField]) => {
    const broken = completeReportInput(patch);
    assert.equal(__internal.firstIncompleteField(broken), expectedField, `expected "${expectedField}" for patch ${JSON.stringify(patch)}`);
  });
});

test('__internal.sanitizeReportTags strips tag-like substrings recursively but leaves normal prose and numbers untouched', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(
    __internal.sanitizeReportTags('Cost was <parameter name="estimate_low"> around $3,200 for the year.'),
    'Cost was around $3,200 for the year.'
  );
  assert.equal(
    __internal.sanitizeReportTags('A 33-inch fridge with $2,400 price and 8-year horizon.'),
    'A 33-inch fridge with $2,400 price and 8-year horizon.',
    'ordinary prose containing angle-bracket-free numbers/units must be untouched'
  );
  assert.deepEqual(
    __internal.sanitizeReportTags({ a: ['ok', '<b>bad</b> good'], b: { c: '<x>' } }),
    { a: ['ok', 'bad good'], b: { c: '' } },
    'must recurse through arrays and nested objects'
  );
  assert.equal(__internal.sanitizeReportTags(42), 42, 'non-string values must pass through unchanged');
});

test('__internal.mapToGenericReport always emits exactly six core sections in a fixed, promise-matching order', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const generic = __internal.mapToGenericReport(completeReportInput());
  const titles = generic.sections.slice(0, 6).map((s) => s.title.toLowerCase());
  assert.match(titles[0], /total cost of ownership/);
  assert.match(titles[1], /financing/);
  assert.match(titles[2], /maintenance/);
  assert.match(titles[3], /depreciation/);
  assert.match(titles[4], /compares/);
  assert.match(titles[5], /recommendation/);
});

test('__internal.buildSystemPrompt grounds the prompt in the customer\'s submitted structured fields and forbids declaring insufficiency', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const prompt = __internal.buildSystemPrompt(fakeSubmission());
  assert.match(prompt, /LG 33-inch French door refrigerator/);
  assert.match(prompt, /2400/);
  assert.match(prompt, /30301/);
  assert.match(prompt, /do not respond by asking for more information or declaring the input insufficient/i);
  assert.match(
    prompt,
    /never write out tool-call, function-call, or parameter-tag syntax/i,
    'must explicitly instruct the model against the leaked-artifact failure mode seen in production on 2026-08-31'
  );
});

// --- the cost model -------------------------------------------------------
//
// Everything below covers one live defect. The paid report for submission
// 29e81bc7 (2026-09-07, a 2023 RAV4 Hybrid held 7 years) put fuel at
// $9,000-$11,000 in its total-cost section and ALL running costs at
// $900-$1,100 a year — $6,300-$7,700 over the same 7 years — in its
// running-costs section three sections later. Roughly $3,000 apart on the
// same line item, with the larger figure feeding the headline range the
// customer reads first. Both paragraphs were fluent; nothing threw; every
// required field was present. The only way to notice was to sit down and
// do the arithmetic, which is the one thing this product is bought to save
// you doing.

// The real numbers from that report, in the shape the engine now requires.
function contradictoryReport() {
  return completeReportInput({
    total_cost_of_ownership: {
      time_horizon_years: 7,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 32400, high: 32400, basis: 'the quoted CPO price' },
        { label: 'Interest over 60 months', kind: 'financing', low: 5200, high: 6400, basis: '60 months at 6.5-7.5% APR' },
        { label: 'Fuel', kind: 'running', low: 9000, high: 11000, basis: '12,000 mi/yr at 38-40 mpg' },
      ],
      explanation: 'Purchase price, interest and running costs over seven years.',
    },
    maintenance_running_costs: {
      annual_low: 900,
      annual_high: 1100,
      explanation: 'Fuel, insurance, tyres and scheduled servicing.',
    },
  });
}

test('__internal.tcoArithmeticProblem catches the live contradiction that shipped to a paying customer', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const problem = __internal.tcoArithmeticProblem(contradictoryReport());
  assert.ok(problem, 'a $3,000 disagreement on the same line item must be caught');
  // The message is handed straight back to the model as the repair prompt,
  // so it has to quote the figures rather than just name the fields.
  assert.match(problem, /\$9,000/);
  assert.match(problem, /\$6,300/);
  assert.match(problem, /7 years/);
});

test('__internal.tcoArithmeticProblem passes a report whose two sections agree', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.tcoArithmeticProblem(completeReportInput()), null);
});

test('__internal.tcoArithmeticProblem tolerates ordinary rounding but not a real gap', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const nudged = (runLow, runHigh) => completeReportInput({
    total_cost_of_ownership: {
      time_horizon_years: 8,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'the quoted price' },
        { label: 'Electricity', kind: 'running', low: runLow, high: runHigh, basis: 'typical rates' },
        { label: 'Delivery', kind: 'other', low: 100, high: 150, basis: 'typical fee' },
      ],
      explanation: 'x',
    },
  });
  // annual 55-70 over 8 years = 440-560. The slack is the greater of 10%
  // or $200, so a $150 rounding difference is fine and a $900 one is not.
  assert.equal(__internal.tcoArithmeticProblem(nudged(500, 620)), null, 'rounding inside a range must not trip the check');
  assert.ok(__internal.tcoArithmeticProblem(nudged(1400, 1600)), 'a genuine disagreement must trip it');
});

test('__internal.tcoArithmeticProblem catches running costs missing from the breakdown entirely', () => {
  // The other way the same money goes wrong: the per-year figure is stated,
  // the customer reads it, and it is nowhere in the total they are quoted.
  const { __internal } = require('../api/_lib/purchase-engine');
  const problem = __internal.tcoArithmeticProblem(completeReportInput({
    total_cost_of_ownership: {
      time_horizon_years: 8,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'the quoted price' },
        { label: 'Delivery', kind: 'other', low: 100, high: 150, basis: 'typical fee' },
        { label: 'Installation', kind: 'other', low: 0, high: 200, basis: 'if a water line is needed' },
      ],
      explanation: 'x',
    },
  }));
  assert.match(problem, /no line of kind "running"/);
});

test('__internal.isReportComplete rejects a report that contradicts itself even though every field is filled', () => {
  // The point of the whole exercise: the report that shipped would pass any
  // check that only asks "is this field non-empty".
  const { __internal } = require('../api/_lib/purchase-engine');
  const bad = contradictoryReport();
  for (const key of ['headline', 'summary', 'recommendation', 'assumptions', 'alternative_comparison']) {
    assert.ok(bad[key], 'sanity: the fixture really is otherwise complete (' + key + ')');
  }
  assert.equal(__internal.isReportComplete(bad), false);
  assert.equal(__internal.firstIncompleteField(bad), 'total_cost_of_ownership.arithmetic');
});

test('__internal.validBreakdown refuses a breakdown that cannot be summed into an honest total', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const withItems = (items) => ({ time_horizon_years: 8, cost_breakdown: items, explanation: 'x' });
  const ok = [
    { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'quoted' },
    { label: 'Electricity', kind: 'running', low: 440, high: 560, basis: 'typical' },
    { label: 'Delivery', kind: 'other', low: 100, high: 150, basis: 'typical' },
  ];
  assert.ok(__internal.validBreakdown(withItems(ok)));
  assert.equal(__internal.validBreakdown(withItems(ok.slice(0, 2))), null, 'fewer than three line items is not a breakdown');
  assert.equal(__internal.validBreakdown(withItems(ok.slice(1))), null, 'no purchase line means the biggest cost is missing');
  assert.equal(
    __internal.validBreakdown(withItems([{ ...ok[0] }, { ...ok[1], low: -440, high: -300 }, ok[2]])),
    null,
    'a negative running cost is a mistake, not a modelling choice'
  );
  assert.equal(
    __internal.validBreakdown(withItems([ok[0], { ...ok[1], low: 900, high: 400 }, ok[2]])),
    null,
    'a range whose high is below its low cannot be summed into anything meaningful'
  );
  assert.equal(
    __internal.validBreakdown(withItems([ok[0], { ...ok[1], basis: '' }, ok[2]])),
    null,
    'a number with no stated basis is the kind of figure this product exists to avoid'
  );
  // Money coming back at the end is the one line allowed to be negative.
  assert.ok(__internal.validBreakdown(withItems(ok.concat([
    { label: 'Resale at year 8', kind: 'resale_recovery', low: -300, high: -100, basis: 'scrap value' },
  ]))));
});

test('a report that contradicts itself is rebuilt by a targeted repair instead of burning a whole attempt', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let mainCalls = 0;
  let costModelRepairs = 0;
  let repairPromptSeen = '';
  global.fetch = async (url, opts) => {
    if (repairKind(opts) === 'cost_model') {
      costModelRepairs++;
      repairPromptSeen = JSON.parse(opts.body).messages[0].content;
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: {
              time_horizon_years: 7,
              cost_breakdown: [
                { label: 'Purchase price', kind: 'purchase', low: 32400, high: 32400, basis: 'the quoted CPO price' },
                { label: 'Interest over 60 months', kind: 'financing', low: 5200, high: 6400, basis: '60 months at 6.5-7.5% APR' },
                { label: 'Fuel, insurance, servicing', kind: 'running', low: 6300, high: 7700, basis: '$900-$1,100/yr over 7 years' },
              ],
              annual_low: 900,
              annual_high: 1100,
            },
          }],
        }),
      };
    }
    mainCalls++;
    return toolUseResponse(contradictoryReport());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(mainCalls, 1, 'a contradiction must cost one small repair call, not a whole regenerated report');
  assert.equal(costModelRepairs, 1);
  assert.equal(submission.generation_attempts, 1);
  assert.equal(reportInserts.length, 1);
  // The repair prompt has to name the contradiction. "Try again" would just
  // reproduce it: both of the original paragraphs looked right on their own.
  assert.match(repairPromptSeen, /\$9,000/);
  assert.match(repairPromptSeen, /\$6,300/);
  const total = report.key_numbers.find((n) => /total cost/i.test(n.label));
  assert.equal(total.value, '$43,900 – $46,500', 'the stored total must be the repaired line items summed');
});

test('a repair that still does not reconcile is rejected rather than shipped', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    if (repairKind(opts) === 'cost_model') {
      // Splits the difference instead of picking one — still inconsistent.
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: {
              time_horizon_years: 7,
              cost_breakdown: [
                { label: 'Purchase price', kind: 'purchase', low: 32400, high: 32400, basis: 'quoted' },
                { label: 'Interest', kind: 'financing', low: 5200, high: 6400, basis: 'APR' },
                { label: 'Fuel', kind: 'running', low: 8000, high: 9500, basis: 'mpg' },
              ],
              annual_low: 900,
              annual_high: 1100,
            },
          }],
        }),
      };
    }
    return toolUseResponse(contradictoryReport());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const result = await generatePurchaseReport('sub-1');

  assert.equal(result, null, 'a repair that does not reconcile must hand back for another attempt');
  assert.equal(submission.status, 'paid');
  assert.equal(reportInserts.length, 0, 'a self-contradicting report must never reach a customer');
});

// --- the summary strip ----------------------------------------------------

test('__internal.mapToGenericReport computes the total from the line items rather than trusting a stated one', () => {
  // The old mapping read optional low_end/high_end strings. On the live
  // report the model wrote its numbers into the prose and left those blank,
  // so the summary strip at the top of the page contained exactly one
  // entry — the word "BUY" — above prose discussing $55,000-$66,000.
  const { __internal } = require('../api/_lib/purchase-engine');
  const generic = __internal.mapToGenericReport(completeReportInput());
  const labels = generic.key_numbers.map((n) => n.label);
  assert.equal(generic.key_numbers.length, 3, 'total, running cost and recommendation — this report pays cash');
  assert.match(labels[0], /Total cost of ownership \(8yr\)/);
  // 2400 + (440..560) + (100..150)
  assert.equal(generic.key_numbers[0].value, '$2,940 – $3,110');
  assert.equal(generic.key_numbers[1].value, '$55 – $70/yr');
  assert.equal(generic.key_numbers[2].value, 'BUY');
});

test('__internal.mapToGenericReport shows the interest cost when the customer is financing', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const generic = __internal.mapToGenericReport(completeReportInput({
    financing_impact: { applicable: true, explanation: 'A 60-month loan at 6.5-7.5%.' },
    total_cost_of_ownership: {
      time_horizon_years: 8,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'quoted' },
        { label: 'Interest', kind: 'financing', low: 300, high: 420, basis: '24 months at 9.9%' },
        { label: 'Electricity', kind: 'running', low: 440, high: 560, basis: 'typical' },
      ],
      explanation: 'x',
    },
  }));
  const financing = generic.key_numbers.find((n) => /interest/i.test(n.label));
  assert.equal(financing.value, '$300 – $420');
});

test('__internal.mapToGenericReport prints the line items above the total, each with its basis', () => {
  // So a customer can check the sum themselves. This is the part that makes
  // the arithmetic falsifiable rather than something to take on trust.
  const { __internal } = require('../api/_lib/purchase-engine');
  const items = __internal.mapToGenericReport(completeReportInput()).sections[0].items;
  assert.equal(items[0], 'Purchase price — $2,400 · the quoted price');
  assert.equal(items[1], 'Electricity — $440 – $560 · $55-$70/yr at typical U.S. rates');
  assert.equal(items[3], 'Total over 8 years — $2,940 – $3,110');
  assert.ok(items[4].includes('electricity over 8 years'), 'the prose explanation still follows the numbers');
});

// --- did research actually happen -----------------------------------------

test('__internal.countSearchRounds reads the response, not the model\'s claim about itself', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.countSearchRounds({ content: [{ type: 'text', text: 'I searched extensively.' }] }), 0);
  assert.equal(__internal.countSearchRounds({
    content: [
      { type: 'server_tool_use', name: 'web_search', input: {} },
      { type: 'server_tool_use', name: 'web_search', input: {} },
    ],
  }), 2);
  assert.equal(__internal.countSearchRounds({ content: [], usage: { server_tool_use: { web_search_requests: 3 } } }), 3);
});

test('a report generated without any live research says so, and its research notes are dropped', async (t) => {
  // buying.html tells the customer the analysis "uses live web research
  // where it can sharpen a figure". The live report of 2026-09-07 ran zero
  // searches and said nothing about it, so the customer had no way to know
  // the figures were training-knowledge estimates.
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => toolUseResponse(completeReportInput({
    research_notes: ['Current listings show similar models from $1,800-$2,600.'],
  }));
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.match(report.missing_or_uncertain[0], /No live web research ran/);
  assert.ok(
    !report.sections.some((s) => /live research/i.test(s.title)),
    'a research section must not appear when no search ran, whatever the model wrote in research_notes'
  );
  assert.equal(reportInserts.length, 1);
});

test('a report that did search keeps its research section and carries no disclaimer', async (t) => {
  const submission = fakeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => searchedToolUseResponse(completeReportInput({
    research_notes: ['Current listings show similar models from $1,800-$2,600.'],
  }), 3);
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.ok(report.sections.some((s) => /live research/i.test(s.title)));
  assert.ok(!report.missing_or_uncertain.some((m) => /No live web research/.test(m)));
});

// --- assumptions ----------------------------------------------------------

test('__internal.isReportComplete rejects an empty or near-empty assumptions list', () => {
  // This used to pass, on the reasoning that "there truly were none" is
  // sometimes honest. It never is here: the live report showed a seven-year
  // total with an empty list, so the customer saw a number whose assumed
  // fuel price, APR and insurance rate were all invisible.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.isReportComplete(completeReportInput({ assumptions: [] })), false);
  assert.equal(__internal.isReportComplete(completeReportInput({ assumptions: ['Assumed a typical electricity rate.'] })), false);
  assert.equal(__internal.isReportComplete(completeReportInput({ assumptions: ['  ', ''] })), false);
  assert.equal(__internal.firstIncompleteField(completeReportInput({ assumptions: [] })), 'assumptions');
  assert.equal(__internal.isReportComplete(completeReportInput()), true);
});

test('an empty assumptions list is refilled by a targeted repair rather than a full retry', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let mainCalls = 0;
  global.fetch = async (url, opts) => {
    if (repairKind(opts) === 'assumptions') {
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: { assumptions: ['Electricity at $0.16/kWh.', 'About 550 kWh a year of draw.', 'No extended warranty.'] },
          }],
        }),
      };
    }
    mainCalls++;
    return toolUseResponse(completeReportInput({ assumptions: [] }));
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(mainCalls, 1);
  assert.equal(submission.generation_attempts, 1);
  assert.equal(reportInserts.length, 1);
  const section = report.sections.find((s) => /assumptions/i.test(s.title));
  assert.equal(section.items.length, 3);
  assert.ok(section.items[0].includes('$0.16/kWh'));
});

// --- the prompt -----------------------------------------------------------

test('__internal.buildSystemPrompt tells the model the total is computed for it, and that research is expected', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const prompt = __internal.buildSystemPrompt(fakeSubmission());
  assert.match(prompt, /you should not state one/i, 'the model must be told the total is summed from its line items');
  assert.match(prompt, /checked against each other in code/i, 'and that the two running-cost figures are reconciled');
  assert.match(prompt, /Search before you write/i, 'searching is no longer framed as optional');
  assert.match(prompt, /zero is not acceptable/i);
  assert.match(prompt, /\$29/, 'the prompt still told the model the customer paid $39 after the price moved to $29');
  assert.ok(!prompt.includes('$39'));
});

test('a financing customer whose breakdown has no financing line is caught, not quietly shipped', () => {
  // "Financing cost impact" is one of the six things buying.html sells, and
  // its figure is read off the breakdown. Without a financing line the
  // promise disappears from the summary strip with nothing to show it went.
  const { __internal } = require('../api/_lib/purchase-engine');
  const noFinancingLine = completeReportInput({
    financing_impact: { applicable: true, explanation: 'A 24-month store card at 9.9%.' },
  });
  const problem = __internal.tcoArithmeticProblem(noFinancingLine);
  assert.match(problem, /no line of kind "financing"/);
  assert.equal(__internal.isReportComplete(noFinancingLine), false);

  const withFinancingLine = completeReportInput({
    financing_impact: { applicable: true, explanation: 'A 24-month store card at 9.9%.' },
    total_cost_of_ownership: {
      time_horizon_years: 8,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'quoted' },
        { label: 'Interest', kind: 'financing', low: 300, high: 420, basis: '24 months at 9.9%' },
        { label: 'Electricity', kind: 'running', low: 440, high: 560, basis: 'typical' },
      ],
      explanation: 'x',
    },
  });
  assert.equal(__internal.tcoArithmeticProblem(withFinancingLine), null);
  // A genuine 0% promotional loan is a real answer, as long as it is stated.
  const zeroInterest = JSON.parse(JSON.stringify(withFinancingLine));
  zeroInterest.total_cost_of_ownership.cost_breakdown[1] = {
    label: 'Interest', kind: 'financing', low: 0, high: 0, basis: '0% promotional financing for 24 months',
  };
  assert.equal(__internal.tcoArithmeticProblem(zeroInterest), null);
});
