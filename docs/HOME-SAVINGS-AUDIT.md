# StreamNavigator Home Savings — Engine Audit Report

An evaluation of `/home-savings` — the page, the intake, the engine behind it,
and whether a customer who pays $49 gets more than $49 back.

Conducted 2026-09-19 against production (streamnavigator.ai/home-savings) and
against `home-savings.html`, `api/navigator-intake.js`,
`api/_lib/navigator-engine.js`, `navigator-subscription-engine.js` and
`prices.config.json` at `6b46626`. **No paid model runs were spent.** Findings
rest on the live page, the code, and 90 deterministic engine runs executed
offline against `navigator-subscription-engine.js`. `/closing` is the design and
engineering standard throughout, as the brief directs; `/subscriptions` is used
as the decision-logic standard, because it is this company's own answer to the
decision problem and it is a good one.

---

## 0. A correction to the brief's premise, and what was audited instead

The brief describes a product that takes a list of subscriptions without login
credentials and returns **continue / suspend / restart** calls, weighing usage,
recency, seasonality, switching costs, redundancy and reactivation cost.

**That product exists on this site, and it is not `/home-savings`.** It is
`/subscriptions`, priced at $29, running a deterministic engine
(`navigator-subscription-engine.js`, 1,212 lines, 12 named rules, a safety pass
and a saving-kind discipline). `/home-savings` is a different product: a
**$49 one-time audit of uploaded household bills** — utilities, internet, phone,
insurance, gym and warehouse memberships. It has no usage questions, no
suspend/restart verbs, and its own FAQ explicitly routes subscription decisions
elsewhere:

> "App and streaming subscriptions are a different problem — deciding those needs
> to know when you last used each one and whether you would miss it, which no
> statement can tell us."

That routing is correct and is to the site's credit. The two products were
deliberately separated on 2026-09-19 (`docs/SUBSCRIPTIONS-AUDIT.md`), which is
the same day this audit runs — the brief appears to predate that split.

**Assumption, documented as the brief requires:** rather than reporting "the
scenarios do not apply," this audit does both jobs. Sections 4–6 run the brief's
thirteen decision scenarios against the engine that actually implements those
verbs (`/subscriptions`), because that is the only way the brief's core question
— *is the decision logic any good?* — can be answered without spending money.
Everything else audits `/home-savings` as shipped.

---

## Executive Summary

**`/home-savings` does not currently deliver its central promise, and the reason
is structural, not cosmetic.**

The page's headline deliverable is: *"Which recurring expenses look priced above
what that service usually costs."* Behind that sentence there is no engine. There
is a **201-word prompt** in `PRODUCT_CONFIGS['home-savings']`
(`api/_lib/navigator-engine.js:192`) handed to `claude-sonnet-5`, instructed to
judge market rates from "your general knowledge of typical U.S. pricing
patterns." The site's own footer then concedes the problem in writing:

> "We do not hold a database of current prices and do not look them up."

So the product's primary claim is a model's undated, un-regional recollection of
what things cost, sold at $49 as a market comparison. That is the one finding
that matters most, and everything below follows from it.

The contrast inside the same repository is the evidence. `/closing` ($59) runs 28
named deterministic checks. `/rental` and `/landlord` ($149) run audit engines
that decide while the model only writes up. `/subscriptions` ($29) runs a
1,212-line engine whose three most important rules are the ones that **refuse**
to find savings. `/home-savings` has none of this, no test file asserting
anything about its output, and the second-highest price of the four.

Three further defects, each verified in code rather than inferred:

1. **A customer can pay $49 for a report the engine will then refuse to
   produce.** `requiresFiles: true` is enforced at *generation* time
   (`navigator-engine.js:615`), after payment. The intake gate
   (`navigator-intake.js:170`) accepts a description *or* a file. `/buying`,
   `/subscriptions` and `/landlord` each got a structured pre-payment gate with a
   comment stating a customer "cannot reach checkout with input this endpoint
   would then reject." `/home-savings` never got one. The money is refunded
   automatically (`failurePatch`, `refund_state='due'`), so this is a trust and
   fee cost rather than theft — but it is the same D-04 defect, still open.
2. **The page sells a refresh that nothing grants.** Step 2 promises "a refreshed
   check as your bills change through the year"; the price card repeats it. The
   FAQ then contradicts it: "Each audit is its own $49 report… that is a fresh
   upload and a fresh report." `ENTITLED_PRODUCTS` is `['rental','landlord']` —
   home-savings has no entitlement. `tests/navigator-claims.test.js` exists
   specifically to catch this class of claim and **passes**, because its regex
   matches "a full year" and "ongoing monitoring" but not "through the year."
3. **The customer is shown nothing before paying.** `/closing` puts a worked
   ledger in the hero and a "Sample report" section in its nav. `/subscriptions`
   runs a free scorecard in the browser and says "if we find nothing, you will
   know before you pay." `/home-savings` offers no sample, no scorecard, no
   example finding, and no evidence of any kind — then asks for $49.

**What is genuinely good:** the separation from `/subscriptions` is honest and
well-argued; the footer disclaimer is unusually candid; refusing to fabricate
specific promotional prices is the right instinct; automatic refunding on
failure is better than most of the category.

**Bottom line: the discovery half of this product is sound and the decision half
is unbuilt.** A real, defensible product is available here without buying a price
database — it is built from checks that are arithmetic on the customer's own
bills. That product is described in section 16 and is not what ships today.

---

## Product Promise

Stated on the page, verbatim:

| Promise | Location | Delivered? |
|---|---|---|
| "Which recurring expenses look priced above what that service usually costs" | What you get | **No** — no price reference exists; the footer says so |
| "What to cancel outright" | What you get | Partially — model judgement, no usage input |
| "What to downgrade without losing what you actually use" | What you get | **No** — the page never asks what they use |
| "What to switch providers for, and to whom" | What you get | Partially — "type of alternative," not a named one |
| "What's worth calling to renegotiate — and what to say" | What you get | **Yes** — genuinely deliverable from a bill alone |
| "Total estimated annual savings" | What you get | Unverifiable — no kind discipline, no basis |
| "A refreshed check as your bills change through the year" | Step 2, price card | **No** — no entitlement; FAQ contradicts it |
| "Delivered automatically, usually within a couple of minutes" | Price card | Yes |
| "Ranked by expected savings, highest first" | Price card | Unenforced — no deterministic rank exists |

Nine promises. Two are met cleanly.

---

## What Was Tested

- **The live page** at streamnavigator.ai/home-savings — full copy, form, FAQ,
  footer, rendered screenshot.
- **The live `/closing` page** as the design and funnel reference.
- **The intake path**: `home-savings.html` client gate → `api/navigator-intake.js`
  → `api/_lib/navigator-engine.js` generation, read end to end.
- **The engine**: `PRODUCT_CONFIGS['home-savings']`, the generic 11-product
  report schema, and the `requiresFiles` enforcement point.
- **The decision logic**, via 90 offline runs of
  `navigator-subscription-engine.js`: the brief's 13 scenarios plus 5 additions,
  and an exhaustive 72-cell sweep of every `lastUsed × wouldMiss × usedBy`
  combination.
- **The design systems**: `navigator-shared.css` vs `navigator-editorial.css` vs
  the inline block in `closing.html`, token by token.
- **The test suite**: `tests/navigator-claims.test.js` run live (12 pass).

**Could not be verified without spending money or private access:** the actual
text of a generated `/home-savings` report. There is no free scorecard, no sample
report and no fixture, and the engine calls a paid model. This is itself a
finding — every product on this site with a deterministic half can be tested for
free, and this one cannot be tested at all. It is the only priced Navigator with
no behavioural test of its output.

---

## Engine Assessment

### `/home-savings` — the engine under audit

The complete decision logic is 201 words of prose. It is reproduced here because
its brevity is the finding:

> "Review every bill provided: identify what's being paid for and how much, and
> assess whether each looks priced above a typical market rate for that category,
> using your general knowledge of typical U.S. pricing patterns — clearly flag
> when you're not confident about a current, region-specific rate rather than
> inventing one. For each recurring expense give one clear recommendation: cancel
> outright, downgrade…, switch providers…, or renegotiate… Total an estimated
> annual savings figure, show your reasoning, and label it clearly as an
> estimate."

What this cannot do, structurally:

| Factor the brief asks about | Available to this engine? |
|---|---|
| Monthly / annual cost | Yes — on the bill |
| Actual usage, frequency, recency | **No input exists** |
| Customer-reported importance | **No input exists** |
| Redundancy / overlap | Only if two bills are uploaded and the model notices |
| Seasonality | **No** — one statement is one month |
| Switching costs | Model judgement, ungrounded |
| Cancellation difficulty | **No** — no policy table |
| Suspension availability | **No** — no `canPause` data |
| Reactivation cost | **No** |
| Promotional pricing | Only if the expiry is printed and the model reads it |
| Price increases | **No** — needs two statements; never requested |
| Free alternatives | Model judgement |
| Household use | **No input exists** |

Eight of thirteen factors have no input path. The four verbs the page sells
(cancel / downgrade / switch / renegotiate) turn on exactly the factors that are
missing. Only **renegotiate** is properly supported by a single bill, and it is
the one the page treats as an afterthought.

**A model asked to judge market rates from memory will produce confident,
plausible, unfalsifiable numbers.** There is no check that would catch it being
wrong, and no test that asserts it isn't.

### `/subscriptions` — the engine that does the brief's job

Tested exhaustively and offline. It is a genuinely good piece of engineering, and
the gap between it and `/home-savings` is the shape of the work to be done.

What it gets right:

- **Saving kinds are never mixed.** `confirmed` / `conditional` / `at_risk` /
  `unpriced`, with `at_risk` shown and never added, and `unpriced` never
  estimated. A rotation counts only the billing cycles actually skipped — the
  engine refuses to print a full year's cost as the saving on a two-month pause.
- **A safety pass that can only downgrade an action, never raise one.** This makes
  "never cancel a shared plan" an invariant a test can assert over arbitrary
  input, rather than a branch someone has to find. Verified: across all 72 answer
  combinations, no safety rule ever produced a more aggressive recommendation.
- **The three refusals**: never cancel a prepaid annual plan mid-term (R1), never
  cancel what someone else in the house uses (R4), never cancel what holds the
  customer's data (R3). In all three the obvious read of the usage signal points
  at the answer that leaves the customer worse off.
- **An integrity floor** (R10, `TRIVIAL_MONTHLY = $5.00`) that stops the engine
  drifting toward eight cancellations the customer regrets in order to inflate a
  headline number.
- **Real cancellation URLs or none** — 20 hand-checked services, never a guess.

---

## Decision Logic

### What the engine considers

Verified by running it: `lastUsed`, `wouldMiss`, `usedBy`, `price`, `period`,
`renewalDate`, `prepaid`, `status` (active/cancelled), `promoRate`,
`bundledWith`, `seasonal` (named sport or month range), plus per-category facts
(`holdsData`, `canPause`, `contractRisk`, `bundleParent`, tier tables).

### What it misses

1. **No "planned future use" input.** The brief's future-use scenario has no
   field. A customer who has not opened Coursera in six months but starts a
   course in three weeks cannot say so.
2. **No cost-of-switching-back input** beyond the promo flag.
3. **Seasonality must be volunteered.** The customer has to know to declare it.

---

## False Positives / False Negatives

The engine produced **zero false positives** across 90 runs — it never
recommended cancelling something a reasonable customer should keep. The safety
pass works. The defects are all in the other direction.

### Defect 1 — R11 tells the customer information is missing when they supplied all of it

**Confirmed.** In **8 of 72** answer combinations (11%), the engine returns
`REVIEW / R11` with the explanation *"We do not have enough from you to call this
one either way"* — while `needs` is empty, because the customer answered all
three questions.

The affected cells are every case of **"I'd miss it, but I haven't used it
lately"** with no cheaper tier available:

```
2-3-months   / a-bit  / just-me            -> review R11  needs=[]
2-3-months   / a-lot  / just-me            -> review R11  needs=[]
6-plus-months/ a-lot  / just-me            -> review R11  needs=[]
never        / a-lot  / just-me            -> review R11  needs=[]
   (+ the four someone-else-too variants)
```

What the customer receives, verified against the rendered fields:

```
── Planet Fitness gym — your call, not ours        [R11 conf=none]
   why:    We do not have enough from you to call this one either way.
   doThis: Read the reason above and decide it yourself — we are not going
           to decide it for you.
   annualCost: 720
```

That is a **$720/year** line — the single most expensive item in the test set,
and the archetypal wasted household subscription — and the report's stated reason
for having no view is false. The customer answered every question the form asked.
This is not a missing-input problem; it is a missing *rule*. The honest output is
"you are paying $720 a year for something you have never used and say you would
miss a lot — that combination usually means an intention, not a use. Set a date
to go, or cancel."

The same cell catches the brief's **false-economy** scenario (TurboTax, $120/yr,
used once a year, would miss a lot → `R11`, empty `needs`) and its **future-use**
scenario (Coursera, $588/yr → `R11`, empty `needs`). Two of the thirteen
scenarios the brief asks about land in the one cell whose explanation is wrong.

**Customer consequence:** on the lines where an honest engine adds the most value
— high cost, low usage, high stated attachment — the report says nothing and
blames the customer for it.

### Defect 2 — a promotional rate on a kept subscription produces no warning at all

**Confirmed.** R5 (`navigator-subscription-engine.js:708`) fires only when
`wouldLoseAccess` is true — i.e. on cancel / rotate / cancel-and-return /
downgrade. A `KEEP` never reaches it:

```
── Keep Xfinity Internet                          [R6 conf=high]
   why:      You used it this month and said you would miss it a lot.
             You are getting what you pay for.
   doThis:   Nothing to do. Leave it as it is.
   cautions: []
```

The customer declared `promoRate: true`. They are told they are "getting what
they pay for" and to do nothing — with no mention that the price is about to
rise. A $35/month promo reverting to $89 is **$648/year**, which would be the
largest single finding in most households, and it is silently dropped.

This is the brief's promotional-pricing scenario, and it is a **missed
opportunity of the most valuable kind**: the engine is at its most confident
exactly where it is most wrong. R5's own comment says a promo rate "is invisible
in every usage signal" — correct, and the rule is then gated behind a usage-driven
action.

**Fix:** move the `cautions.push({kind:'promo'})` out of the `wouldLoseAccess`
branch so it attaches to every promo line regardless of action, and add a
`KEEP_UNTIL` variant for a promo with a known expiry date.

### Defect 3 (`/home-savings`) — no false-positive protection exists at all

The three refusals that make `/subscriptions` trustworthy have no counterpart in
`/home-savings`. Nothing stops its model recommending the cancellation of an
insurance policy that is cheap because of a long-standing loyalty discount, or a
warehouse membership whose value is the pharmacy, or a phone plan that is
grandfathered and unrepeatable. Whether it does so is unknown, because nothing
checks and nothing is tested.

---

## Savings Analysis

### `/home-savings`

The page promises a "Total estimated annual savings across everything you
uploaded" and to rank findings "by expected savings, highest first." Neither is
enforceable: there is no saving-kind discipline in the generic schema, so a
speculative "you could probably get this down to $60" and a printed, verifiable
equipment-rental fee land in the same total. `/rental` and `/subscriptions` both
forbid exactly this, in near-identical language, for products at $149 and $29.

**What is actually findable from a bill alone, with no price database** — and
this is the encouraging part:

| Finding | Typical value/yr | Basis |
|---|---|---|
| Promotional rate with a printed expiry | $300–700 | On the bill |
| Modem/router rental fee | $120–216 | On the bill |
| Add-ons no longer wanted (wire maintenance, inside-wiring plans, channel packs) | $60–300 | On the bill |
| Device instalments already paid off but still billed | $120–400 | On the bill |
| Duplicate coverage (roadside/rental-car already on a card) | $60–180 | Two documents |
| Autopay / paperless discount not applied | $60–120 | On the bill |
| Year-over-year increase on the same account | varies | Two statements |

Every one of these is **arithmetic on the customer's own documents** — the house
pattern, applied here. None needs a market price table. This is a real product,
and it is not the one being sold.

### Net savings

`Net = Avoided Cost − $49 Fee − Switching/Reactivation Cost`

A customer who finds only the modem rental ($180/yr) nets **$131**. A customer
who finds nothing nets **−$49**, and today has no way to learn that before
paying. `/subscriptions` solved this precisely: *"If the scorecard finds nothing,
you will know that for free."*

---

## Pricing Analysis

**Current price:** $49 one-time (`prices.config.json`, `expectedPriceCents: 4900`,
link verified active).

**Assessment: too high for what ships today, and correctly placed for what should
ship.** The problem is not the number, it is that nothing behind it is earned.
Ranked against its own siblings:

| Product | Price | Deterministic engine | Free pre-purchase step | Behavioural test |
|---|---|---|---|---|
| `/landlord`, `/rental` | $149 | Yes | No | Yes |
| `/closing` | $59 | Yes — 28 checks | Free scorecard | Yes |
| `/contractor` | $49 | Yes | No | Yes |
| **`/home-savings`** | **$49** | **No** | **No** | **No** |
| `/government-money` | $39 | No | No | No |
| `/subscriptions` | $29 | Yes — 12 rules | Free scorecard | Yes |

`/home-savings` is priced level with `/contractor`, which has a real engine, and
at 1.7× `/subscriptions`, which has a better one. A customer comparing the two
pages on this site sees $29 buy a free scorecard, named rules, real cancellation
links and a dated restart, and $49 buy a promise.

**Recommended price: $39 one-time, with a free scorecard first.**

**Recommended model: free deterministic scorecard → $39 paid report.** Not a new
model — the one `/closing` and `/subscriptions` already run. Rationale:

- It is the only structure that fixes the credibility problem, because it lets the
  customer see a finding before paying.
- It removes the −$49 downside that currently has no disclosure.
- $39 places it correctly: above `/government-money` (no engine, thinner),
  below `/contractor` and `/closing` (real engines, richer documents).
- Bills carry less internal arithmetic than a Closing Disclosure, so this
  product's deterministic half will always be thinner than `/closing`'s. $39
  reflects that honestly.

**$49 becomes defensible** — and I would recommend returning to it — once the
page can name a specific number of checks it runs, the way `/landlord` does, with
a test asserting the number sold equals the number the catalog runs
(`tests/navigator-claims.test.js` already has that test written for another
product; it extends in an afternoon).

**Do not adopt:** percentage-of-savings (unverifiable without bank access, which
is the differentiator being sold away), or any subscription (the "nothing to
cancel" line is a genuine asset in a category full of Rocket Money-style
recurring fees).

---

## UX Audit

### Clarity — good
The headline "Audit your household bills in one upload" is understood in under
five seconds, and the routing to `/subscriptions` in the sub-headline is an act
of honesty most sites would not commit.

### Friction — three concrete problems

1. **Dead category selector.** `home-savings.html:265` queries
   `.category-chip`, which **does not exist in the page**. `selectedCategory` is
   permanently `null` and is posted as `null` on every submission. The label
   "What kinds of bills are you uploading?" sits above a free-text box instead.
   *Fix:* either ship the chips or delete the handler and relabel the textarea.
2. **The description field is optional and unvalidated.** The click handler
   checks email and file count only. The engine then receives
   `Customer's description:` with nothing after it.
   *Fix:* require it, or drop it — not both.
3. **No indication of how many bills to upload.** "The more you upload, the more
   thorough" is not a number. Most findings need 2+ documents; duplicate-coverage
   findings need 2 by definition.
   *Fix:* "Most households upload 4–8. Fewer than 3 and there is usually not
   enough to compare."

### Trust — the weakest area
The no-credential model is the single strongest thing about this product and is
**never stated on the page.** `/subscriptions` puts "No bank login, ever" in its
meta description. `/home-savings` never mentions it. Meanwhile the footer
disclaimer — honest, and correctly placed — undercuts the "what you get" list
directly above it, and nothing reconciles them.

### Results
Cannot be assessed; no sample exists. That is the finding.

---

## Visual Audit

`/closing`'s design system lives in `navigator-editorial.css`, whose header
states it is "The /closing design system, lifted verbatim," with
`tests/contractor-design.test.js` comparing it against the inline block in
`closing.html` **character for character** so the two cannot drift.

`/subscriptions` and `/contractor` have already migrated to it.
**`/home-savings` is the outlier: `navigator-shared.css` (the violet/mint
"Canva-inspired" scheme) with zero inline overrides.** The two pages share no
font, no colour, no radius and no shadow.

| Token | `/closing` (target) | `/home-savings` (current) |
|---|---|---|
| Body font | `IBM Plex Sans`, **17px / 1.6** | `Inter`, unset size / 1.55 |
| Headings | **`Newsreader` serif, weight 500**, `-0.01em` | `Sora` sans, weight 700–800, `-0.02em` |
| `h1` | `clamp(2.2rem, 5vw, 3.3rem)` / 1.09 | `clamp(2.4rem, 5.6vw, 4.4rem)` / 1.06 |
| `h2` | `clamp(1.55rem, 3.1vw, 2.05rem)` / 1.18 | Sora, no clamp scale |
| Numerals | **`IBM Plex Mono`, `tabular-nums`** (`.mono`) | none — proportional |
| Background | `#FBFAF7` flat warm paper | violet→mint gradient + 4-point radial `.bg-noise` |
| Ink | `#1B2A3A` navy | `#1F1B16` near-black |
| Accent | `#B01F12` flag / `#2C6A57` ok / `#8A6A16` hold | `#8B5CF6 → #EC4899` gradient |
| Radius | **`2px`** | `20px` / `12px` |
| Shadow | `5px 5px 0 rgba(27,42,58,.08)` | `6px 6px 0 var(--ink)` hard |
| Button | ink fill, `2px` radius, weight **500**, `1rem`, `14px 26px` | gradient fill, pill/`20px`, weight 700+ |
| Container | `1080px` / `28px` gutter, `.col` `780px` | `1180px` / `24px` gutter |
| Section | `60px 0`, `1px solid var(--rule)` bottom | variable, `2px solid var(--ink)` |
| Hero | asymmetric `1.02fr / .98fr` grid, **worked example on the right** | centred, gradient text, no example |

**Recommendation — one line of work, not a redesign:**

```html
<link rel="stylesheet" href="/navigator-editorial.css">
```

replacing `navigator-shared.css`, then rename the page's classes to the editorial
vocabulary (`.hero-grid`, `.lede`, `.sec-intro`, `.steps`, `.ledger`, `.btn`,
`.chk`, `.fig`) exactly as `subscriptions.html` did on the same day. That page is
the worked migration; follow it. Swap the Inter/Sora font link for the
Newsreader / IBM Plex Sans / IBM Plex Mono link on `closing.html:10`.

Specifically for the hero: adopt the `.hero-grid` two-column layout and **put a
worked example in the right column** — a `.ledger` panel showing a redacted
internet bill with the modem rental flagged in `--flag` and a `.note` explaining
it. That single change carries the visual fix and the conversion fix together.

---

## Conversion Audit

**Problem 1 — nothing is shown before the ask.**
*Why it matters:* the only reason to believe a savings claim is to see one. This
page asks for $49 and a folder of personal bills on the strength of assertion.
*Fix:* add a `#sample` section and nav link, mirroring `/closing`. Show one real
finding end to end: the bill line, the flag, the dollar figure, the script to
read down the phone.

**Problem 2 — the headline promises work, not outcome.**
*Why it matters:* "Audit your household bills in one upload" describes what the
customer does. `/closing`'s "Before you sign, know what you're actually paying"
describes what they get.
*Fix, replacement copy:* **"You are probably renting a modem you could own."**
Sub-head: *"Upload your bills. We find the line items you are paying for and no
longer need — the equipment fee, the expired promotion, the add-on from four
years ago — and tell you exactly what to say to stop them."*

**Problem 3 — the self-contradiction on refresh.**
*Why it matters:* step 2 and the FAQ say opposite things about the same $49. A
customer who reads both trusts neither.
*Fix:* delete the refresh claim from step 2 and the price card. Replace step 2's
body with: *"One charge. No subscription, and nothing to cancel later."*

**Problem 4 — the strongest differentiator is unstated.**
*Fix:* add to the pill and the feature list: **"No bank login, ever. You send
documents; we never touch an account."**

**Problem 5 — the downside is undisclosed.**
*Fix:* the free scorecard resolves it. Until it ships, state the policy plainly:
*"If we find nothing worth acting on, we refund you."* Given `process-refunds.js`
already exists, this is close to free to offer and would carry the page.

---

## Competitive / Alternative Value

| Alternative | What it costs | Where `/home-savings` wins | Where it loses |
|---|---|---|---|
| Doing it manually | 2–4 hrs | Nothing is remembered; most people never start | Free, and finds the same top items |
| Reading card/bank statements | 30 min | Statements show the charge, never the **composition** of the bill | Free, catches forgotten charges better |
| A spreadsheet | 1 hr | Same — a spreadsheet records, it does not diagnose | Free |
| Budgeting software (Rocket Money, Copilot) | $4–12/mo or 33–40% of savings | **One charge, no bank login, nothing to cancel** | They negotiate *for* you; that is a real service this does not offer |
| A generic AI assistant | ~free | Structured intake, ranked output, delivery | **Will do essentially this same job from the same uploaded PDFs, today, for nothing** |

**Strongest differentiation:** the no-credential model combined with a one-time
charge, in a category where every competitor wants a bank connection and a
recurring fee. This is real and the page does not say it.

**Weakest differentiation:** *today, a generic AI assistant with the same PDFs
produces comparable output for free.* This is the honest answer to the brief's
section 9, and it is uncomfortable: what `/home-savings` currently adds over
pasting bills into a chat window is packaging. `/closing` is not vulnerable to
this — 28 named checks, a rate-tolerance table and TRID thresholds are not
something a chat window reproduces. `/home-savings` becomes defensible the moment
it has that same deterministic spine, and not before.

---

## Business Economics

Assumptions, labelled as such: hit rates are judgement from the composition of
typical US household bills, not measured data. This product has no outcome
telemetry, which is itself worth fixing.

| Household | Bills | P(material find) | Typical find/yr | Expected gross | Net at $49 | Net at $39 |
|---|---|---|---|---|---|---|
| Low | 5 | ~40% | $120–250 | ~$74 | **+$25** | **+$35** |
| Typical | 10 | ~70% | $250–600 | ~$298 | **+$249** | **+$259** |
| High | 15 | ~85% | $400–900 | ~$553 | **+$504** | **+$514** |

The typical and high cases work comfortably. **The low-value case is the
problem**: a 5-bill household is close to break-even in expectation and has a
~60% chance of a straight $49 loss, with no way to know beforehand. This is
precisely the customer the free scorecard protects, and precisely the customer
most likely to feel defrauded and tell someone.

At $39 with a free scorecard, the low-value customer self-selects out before
paying, the typical customer still nets $259, and the reported hit rate among
*paying* customers rises — which is the number the page will eventually want to
publish.

---

## Critical Problems

### 1. The central claim has no engine behind it

- **Evidence:** `navigator-engine.js:192` — 201 words of prompt. No extraction
  step, no reference data, no check list, no test. The footer concedes: "We do
  not hold a database of current prices and do not look them up."
- **Customer consequence:** the "priced above market" verdict is unfalsifiable.
  Acting on a wrong one costs the customer a service they wanted, or an hour on
  the phone arguing from a number that was never real.
- **Business consequence:** the product cannot be tested, improved, or defended.
  It is also the one product on the site a free chat window substitutes for.
- **Fix:** build `api/_lib/home-savings-audit.js` on the house pattern — extract
  line items from each bill, run named checks that are arithmetic on those items,
  and let the model write up only what the engine decided. Start with the seven
  checks in the Savings Analysis table; none needs external price data.
- **Expected effect:** converts an unfalsifiable opinion into a countable
  deliverable the page can name and a test can assert.

### 2. A customer can pay for a report that cannot be produced

- **Evidence:** `requiresFiles` enforced at `navigator-engine.js:615`, after
  payment. `navigator-intake.js:170` accepts description *or* file. No
  `checkSufficiency` for `home-savings`.
- **Customer consequence:** pays $49, waits, receives a failure and a refund.
- **Business consequence:** Stripe fees on both legs, a support email, and the
  worst possible first impression. It is the D-04 defect fixed three times
  already on other products.
- **Fix:** add `checkHomeSavingsSufficiency(formData, attachmentCount)` requiring
  ≥1 readable document, gate the intake on it, and gate the page's own button on
  the same function — as `/buying`, `/subscriptions` and `/landlord` do.
- **Expected effect:** the failure becomes impossible rather than refundable.

### 3. The page sells a refresh nothing grants, and the test written to catch it misses

- **Evidence:** step 2 and the price card promise a refresh "through the year";
  the FAQ denies it; `ENTITLED_PRODUCTS = ['rental','landlord']`.
  `tests/navigator-claims.test.js` passes because its regex lacks the phrasing.
- **Customer consequence:** believes a second look is included; discovers it is
  not, at $49.
- **Business consequence:** a chargeable claim, on a page that contradicts itself
  in writing two screens apart.
- **Fix:** delete both claims; extend the claims regex with
  `refresh|refreshed check|through the year|as your bills change` so the class
  cannot reappear on the other nine pages.
- **Expected effect:** closes the claim and the hole in the guard that let it
  through — the fix the audit's own precedent demands ("a false claim on one
  Navigator page is probably on four others").

---

## Highest-Value Improvements

### 1. A free deterministic scorecard, in the browser, before payment
Ranked first because it raises all three of the brief's targets at once. It
raises **savings** (the customer sees a finding and acts on it even if they never
pay), **accuracy** (a check that runs client-side is a check that is written down
and testable), and **willingness to pay** (the −$49 downside disappears).
`/closing` and `/subscriptions` both prove the pattern on this codebase.

### 2. Fix R11's empty-`needs` cell and the promo-on-KEEP gap in `/subscriptions`
Two small, surgical changes to a good engine. Together they cover 11% of all
answer combinations plus every promotional rate on a kept line — including the
$648/yr internet case that is the largest single finding most households have.
Both are provable with a unit test the day they ship.

### 3. Move `/home-savings` onto `navigator-editorial.css` and put a worked example in the hero
The cheapest of the three and the most visible. It closes the entire visual audit
in one stylesheet swap plus a class rename, and the `.ledger` example in the hero
is simultaneously the highest-leverage conversion fix. `subscriptions.html` is
the worked precedent from the same week.

---

## Required Changes Before Launch

### Must Fix
1. Pre-payment sufficiency gate requiring ≥1 readable document (Critical 2).
2. Delete the unfunded refresh claim from step 2 and the price card; extend
   `tests/navigator-claims.test.js` to cover the phrasing (Critical 3).
3. Stop selling "priced above what that service usually costs" until something
   can substantiate it. Replace with what is actually deliverable: *"Line items
   on your own bills you are paying for and no longer need."*
4. Either build the deterministic engine (Critical 1) or reprice to $39 and add
   the free scorecard. Shipping neither leaves a $49 page with no evidence
   behind it.

### Should Fix
5. Free scorecard before payment (Improvement 1).
6. Migrate to `navigator-editorial.css` (Improvement 3).
7. Fix R11 empty-`needs` and promo-on-KEEP in `/subscriptions` (Improvement 2).
8. Add a `#sample` section with one worked finding, and a nav link to it.
9. Delete the dead `.category-chip` handler or ship the chips.
10. State "No bank login, ever" prominently.
11. Add a behavioural test for `/home-savings` output — it is the only priced
    Navigator without one.

### Nice to Have
12. Require or remove the description field.
13. Tell customers how many bills to upload ("most households upload 4–8").
14. Offer the no-findings refund explicitly while the scorecard is being built.
15. Ask for last year's bill alongside this year's — year-over-year increase on
    the customer's own account is a finding needing no external data at all.

---

## Recommended Final Customer Experience

**Landing** — Editorial system, `/closing`'s layout. Headline names the outcome:
"You are probably renting a modem you could own." Right column holds a worked
`.ledger` example: a redacted internet bill, the $15/mo equipment fee flagged in
`--flag`, the annual figure in `IBM Plex Mono`, and the sentence to say on the
phone. Pill reads "No bank login, ever."

**Input** — Two steps. First, free and local: "Which of these are on your bills?"
— a checklist of the seven findable patterns, running in the browser, sending
nothing. It returns a count and a range: *"3 of these look likely on your bills —
worth roughly $290–$520 a year."* Or, honestly: *"Nothing here looks likely.
Don't buy the report."* Second, only if they continue: upload 4–8 bills, email,
pay $39. The button is gated on the same sufficiency function the server enforces.

**Analysis** — `home-savings-audit.js` extracts line items per bill and runs named
checks against them. Every finding carries a check id, a dollar impact, a kind
(`confirmed` / `at_risk` / `unpriced`) and an evidence basis. The model writes up
only what the engine decided and may not originate a figure — the rule already
written three times in this repository.

**Recommendation** — Ranked by confirmed impact. Each finding: the line as it
appears on the bill, what it should be, what that rests on, the annual figure, and
the exact action — including the words to say. Findings the engine cannot price
appear, unpriced, and are never estimated.

**Savings** — Three separate totals, never summed: confirmed, at-risk, and
"needs one more document." The headline number is the confirmed total and nothing
else.

**Action** — A checklist ordered by dollars per minute of effort, each item with
a phone number or a URL that was verified, or a plain statement that it was not.

---

## Final Conclusion

**1. Does Home Savings currently deliver its stated promise?**
No. Two of its nine on-page promises are met. The central one — identifying what
is priced above market — has no mechanism behind it, and the site's own footer
says so.

**2. Does the engine provide genuine incremental value?**
Today, marginally. A generic AI assistant given the same PDFs produces comparable
output for free. What is added is packaging and delivery. This is not true of
`/closing`, `/rental` or `/subscriptions`, and the difference is a deterministic
engine.

**3. Can it realistically save customers money?**
Yes — and this is the reason to fix it rather than retire it. A typical 10-bill
household plausibly carries $250–600/year of findable waste, and the most valuable
findings need no price database at all, only arithmetic on the customer's own
documents. The opportunity is real. The current build does not reliably capture it.

**4. Are the recommendations sufficiently reliable?**
Unknown, and that is the answer. Nothing tests them, no fixture exists, and no
free path produces one. For `/subscriptions`, tested exhaustively, the answer is
**yes with two defects** — no false positives in 90 runs, a correct refusal to
cancel shared, prepaid or data-holding services, and two real misses documented
above.

**5. Is the current price justified?**
No. $49 buys less engine than the $29 product beside it and less than every other
product at or above its price.

**6. What price should StreamNavigator charge?**
**$39 one-time, with a free deterministic scorecard first.** Return to $49 once
the page can name a specific number of checks and a test asserts that the number
sold is the number that runs — the standard `/landlord` is already held to.

**7. What must change before it is ready?**
The four Must Fix items. In order of what a customer feels: stop selling the
market-rate comparison that cannot be performed; stop selling the refresh that is
not granted; make it impossible to pay for a report that cannot be produced; and
either build the engine or price for not having one.

The encouraging finding is that none of this requires anything the company has
not already built four times. `closing-audit.js`, `rental-audit.js`,
`landlord-audit.js` and `navigator-subscription-engine.js` are four working
instances of exactly the pattern `/home-savings` needs, and
`docs/SUBSCRIPTIONS-AUDIT.md` is a worked example of this same gap being found
and closed in a single day. `/home-savings` is the last product on the line still
waiting for it.

---

## Closure — what shipped, 2026-09-19

Every item in Required Changes Before Launch is closed. The audit above is left
as written; this section records what was done about it.

### Must Fix

| # | Item | Closed by |
|---|---|---|
| 1 | Pre-payment sufficiency gate | `checkSufficiency()` in `navigator-home-savings-engine.js`, called by `api/navigator-intake.js` for `home-savings` and by `home-savings-intake.js` to gate the button. One file, so the page and the endpoint cannot drift. Verified in the browser: the old description-only purchase is now refused before Stripe. |
| 2 | The unfunded refresh claim | Deleted from step 2 and the price card. `tests/navigator-claims.test.js` regex extended with `refreshed check`, `a refresh as`, `through the year`, `as your bills change` — the phrasing that slipped past it. `tests/home-savings-claims.test.js` guards the page directly. |
| 3 | "Priced above what that service usually costs" | Gone from the page and from the engine prompt, which now forbids the comparison in terms. The page says so in the body, not only the footer. `tests/home-savings-claims.test.js` fails on seven phrasings of the claim, skipping lines that deny it. |
| 4 | Build the engine, or reprice | **Engine built.** `navigator-home-savings-engine.js` — 7 named checks, a safety pass that can only demote, three saving kinds never summed. |

### The pricing decision

**$49 stands.** The audit recommended $39 *for the unfixed product*, and named
the condition under which $49 is defensible: the page names a specific number
of checks and a test asserts the number sold equals the number the catalog
runs. Both shipped. This is the same reasoning that kept `/landlord` at $149
after its own audit proposed $99 — the discount was priced against defects that
no longer exist. No new Stripe link was needed, which also avoids the
placeholder trap `/subscriptions` is still sitting in.

### Should Fix / Nice to Have

All eleven closed: free scorecard before payment (runs the paid engine in the
browser); migrated to `navigator-editorial.css` with the `.ledger` worked
example in the hero; `#sample` section and nav link; R11 and the promo-on-KEEP
gap fixed in `/subscriptions`; the dead `.category-chip` handler deleted with
the whole old form; "No bank login, ever" in the hero; a behavioural test suite
(22 cases); the description field replaced by the structured bill form; "four to
eight" bills stated; the refund promise stated at the decision point; last
year's bill requested and used by check H7.

### The two `/subscriptions` defects

- **R11 empty `needs`** — new rule **R12** covers the eight cells where all
  three answers were given. The sweep now reports **0 of 72** (was 8 of 72).
  The $720/yr gym gets a true reason and its annual cost, not "we do not have
  enough from you".
- **Promo on a KEEP** — the caution moved out of the `wouldLoseAccess` branch
  and now attaches to every promotional line whatever the action. `stepFor` no
  longer prints "Nothing to do" over a caution.

### What is deliberately NOT done

- **No price corpus.** The product now states plainly that it holds none. The
  seven checks were chosen precisely because none of them needs one.
- **No live report run.** The engine is verified offline against fixtures with
  known answers; no API credits were spent.
- **The engine's document-extraction half is still the model's.** The checks
  run on the structured answers the customer gives; the uploaded bills are read
  by the writer for quoting, under a prompt that forbids originating a finding.
  Extracting line items deterministically from a PDF is a larger piece of work
  and is the obvious next one.

### Verification

`node tests/run-all.js` — **75 of 75 suites pass**, including the 22 new engine
cases and 14 new page-contract cases. The page was driven in a browser: the
scorecard computes live, the two exposure figures render separately, and the
checkout button refuses and never reaches Stripe when no bill is attached.
Every computed style token on `/home-savings` now matches `/closing` — body
`IBM Plex Sans` 17px/1.6 on `#FBFAF7`, `h1` Newsreader 500 at `-0.01em`, button
`2px` radius weight 500, numerals in `IBM Plex Mono`, ledger shadow
`5px 5px 0 rgba(27,42,58,.08)`, and no gradient layer.
