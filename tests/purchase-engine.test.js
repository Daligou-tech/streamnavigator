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
    total_cost_of_ownership: { estimate_low: '$2,700', estimate_high: '$3,100', time_horizon_years: 8, explanation: 'Purchase price plus roughly $400-$500 in electricity over 8 years.' },
    financing_impact: { applicable: false, explanation: 'Paying cash, so there is no financing cost — the $2,400 price is the full cost.' },
    maintenance_running_costs: { annual_estimate: '$50-$70/year', explanation: 'Typical electricity draw for a French door fridge this size, plus occasional minor repairs.' },
    depreciation_resale: { expected_resale_note: 'No meaningful resale market for appliances', explanation: 'Refrigerators are not typically resold for meaningful value; treat this as a sunk cost over its useful life.' },
    alternative_comparison: { alternative_name: 'A comparable top-freezer model, ~$1,600', explanation: 'A simpler top-freezer configuration would cost several hundred dollars less with slightly higher energy use, but no ice/water dispenser.' },
    recommendation: { verdict: 'buy', reasoning: 'Price is in the typical range and the customer already needs a replacement — no reason to wait.' },
    assumptions: ['Assumed a typical U.S. average electricity rate since no exact rate was given.'],
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
        estimate_low: '$2,700',
        estimate_high: '$3,100',
        time_horizon_years: 8,
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

test('an unsupported web_search tool error on the first call falls back to a knowledge-only call and still succeeds', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let call = 0;
  global.fetch = async (url, opts) => {
    call++;
    const parsedBody = JSON.parse(opts.body);
    const usesSearch = (parsedBody.tools || []).some((t) => t.type === 'web_search_20250305');
    if (usesSearch) {
      return { ok: false, status: 400, text: async () => 'invalid_request_error: the web_search tool is not enabled for this API key' };
    }
    return toolUseResponse(completeReportInput());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.ok(call >= 2, 'expected a fallback call without web_search after the first call rejected the tool');
  assert.equal(reportInserts.length, 1);
  assert.ok(report.headline);
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
