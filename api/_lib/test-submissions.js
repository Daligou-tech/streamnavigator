// Decides whether a submission is internal testing rather than a real customer.
//
// Why this exists: by September 2026 `navigator_submissions` held ~135 rows and
// every one of them came from development -- three different addresses used by
// the owner, a dozen synthetic verification runs, and a scattering of QA rows.
// There was no column separating them, so the first genuine conversion would
// have arrived looking exactly like row 136. Retrofitting that judgement later
// means reading each row and guessing; recording it at insert time costs
// nothing and is never ambiguous.
//
// TWO RULES, AND WHY THEY ARE THESE ONES
//
// 1. Reserved domains. RFC 2606 and RFC 6761 set aside .test, .example,
//    .invalid and .localhost, plus example.com/.net/.org, precisely so that
//    they can never be delegated to anyone. No real customer can hold an
//    address there, so this cannot produce a false positive -- which is the
//    property that matters. Marking a real customer as a test would hide the
//    thing the flag exists to reveal.
//
// 2. A +test or +qa subaddress tag. This is the opt-in for testing against a
//    deliverable mailbox, which is necessary whenever the run has to receive
//    the email: use owner+test@gmail.com rather than owner@gmail.com. Note
//    that not every provider supports subaddressing -- Yahoo does not -- so on
//    those a reserved domain is the only option unless the mail is needed.
//
// DELIBERATELY NOT A RULE: anything the client can assert. An `is_test` field
// in the request body would let a visitor decide they are not a customer, and
// would be the obvious first thing to try for anyone probing for a free
// report. The address is the only input, and it is one the customer has
// already committed to for delivery.
//
// THIS IS A MARKER, NOT A MODE. Nothing in the product may branch on it. The
// moment a test submission takes a different path through the code, the flag
// stops describing reality and starts creating a second, untested product --
// and a way to get the paid one for nothing. It exists so that a query can say
// `where is_test = false` and mean it.

'use strict';

// RFC 2606 / RFC 6761. Reserved in perpetuity; never delegated.
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

// Subaddress tags that mean "this is a test run", checked on the local part
// after the first '+'. Kept short on purpose: a customer whose address happens
// to contain the letters "test" (testa@..., protester@...) must not be caught,
// so the tag has to follow a '+' and stand as its own word or prefix.
const TEST_TAGS = ['test', 'qa'];

function isTestEmail(email) {
  if (typeof email !== 'string') return false;
  const address = email.trim().toLowerCase();
  if (!address || address.indexOf('@') === -1) return false;

  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!local || !domain) return false;

  if (RESERVED_DOMAINS.indexOf(domain) !== -1) return true;

  const tld = domain.split('.').pop();
  if (RESERVED_TLDS.indexOf(tld) !== -1) return true;

  // owner+test@gmail.com, owner+qa3@gmail.com -- but not owner+latest@...,
  // where "test" appears inside a longer word.
  const plus = local.indexOf('+');
  if (plus !== -1) {
    const tag = local.slice(plus + 1);
    for (const t of TEST_TAGS) {
      if (tag === t || tag.startsWith(t + '-') || tag.startsWith(t + '_')
          || (tag.startsWith(t) && /^[0-9]/.test(tag.slice(t.length)))) {
        return true;
      }
    }
  }

  return false;
}

module.exports = { isTestEmail, RESERVED_TLDS, RESERVED_DOMAINS, TEST_TAGS };
