import assert from "node:assert/strict";
import test from "node:test";
import {
  draftBodyToHtml,
  normalizeDraftBody,
  signatureHtmlToText,
  stripTrailingSignature,
} from "../src/lib/email/draft-format.ts";

test("normalizeDraftBody joins stray line breaks but preserves paragraphs and lists", () => {
  assert.equal(
    normalizeDraftBody("  Hello there\r\nthis continues.  \r\n\r\n\r\nNext paragraph.\r"),
    "Hello there this continues.\n\nNext paragraph.",
  );
  assert.equal(
    normalizeDraftBody("Items:\n- First\n- Second\n1. Third\n2) Fourth"),
    "Items:\n- First\n- Second\n1. Third\n2) Fourth",
  );
  assert.equal(normalizeDraftBody("Compact list:\n*First\n3)Third"), "Compact list:\n*First\n3)Third");
  assert.equal(
    normalizeDraftBody("Meet me at:\n500 Main St\nSuite 200"),
    "Meet me at:\n500 Main St\nSuite 200",
  );
  assert.equal(
    normalizeDraftBody(
      "Here is my thinking:\nWe should ship the beta in March because the window is closing and we\nneed the feedback loop before summer.",
    ),
    "Here is my thinking: We should ship the beta in March because the window is closing and we need the feedback loop before summer.",
  );
  assert.equal(normalizeDraftBody("Quoted context\n> first line\n> second line"), "Quoted context\n> first line\n> second line");
  assert.equal(normalizeDraftBody("Hello  \n   from Cove"), "Hello from Cove");
  assert.equal(normalizeDraftBody("Hello 👋\nfrom Cove"), "Hello 👋 from Cove");
});

test("stripTrailingSignature removes only a matching non-empty trailing sign-off", () => {
  const signature = "Best,\n\nAlex\nEdge AI";
  assert.equal(
    stripTrailingSignature("Useful prose.\n\nBest,\nAlex\nEdge AI", signature),
    "Useful prose.",
  );
  assert.equal(
    stripTrailingSignature("Useful prose.\r\nBest,\r\nAlex\r\nEdge AI", signature),
    "Useful prose.",
  );
  assert.equal(
    stripTrailingSignature("Useful prose.\n\nBest regards,\nAlexander", signature),
    "Useful prose.\n\nBest regards,\nAlexander",
  );
  assert.equal(stripTrailingSignature("Best,\nAlex\nEdge AI", signature), "Best,\nAlex\nEdge AI");
  assert.equal(stripTrailingSignature("Useful prose.\n\nBest,", null), "Useful prose.\n\nBest,");
});

test("draftBodyToHtml uses Gmail paragraph markup and escapes all body HTML metacharacters", () => {
  assert.equal(
    draftBodyToHtml('<script title="x">Tom & \'Alex\'</script>\n- safe'),
    '<div dir="ltr"><div>&lt;script title=&quot;x&quot;&gt;Tom &amp; &#39;Alex&#39;&lt;/script&gt;<br>- safe</div></div>',
  );
  assert.equal(
    draftBodyToHtml("First paragraph.\n\nSecond paragraph."),
    '<div dir="ltr"><div>First paragraph.</div><div><br></div><div>Second paragraph.</div></div>',
  );
});

test("draftBodyToHtml appends trusted bounded signature markup verbatim", () => {
  const signature = '<div class="gmail_signature"><b>Alex</b></div>';
  assert.equal(
    draftBodyToHtml("Thanks.", signature),
    `<div dir="ltr"><div>Thanks.</div><div><br></div>${signature}</div>`,
  );
  assert.throws(
    () => draftBodyToHtml("Thanks.", `<div>${"x".repeat(21 * 1024)}</div>`),
    /20 KB/,
  );
});

test("draftBodyToHtml safely autolinks absolute web URLs without trailing punctuation", () => {
  assert.equal(
    draftBodyToHtml("Details: https://example.com/path?q=one&view=two."),
    '<div dir="ltr"><div>Details: <a href="https://example.com/path?q=one&amp;view=two">https://example.com/path?q=one&amp;view=two</a>.</div></div>',
  );
  const hostile = draftBodyToHtml('<script>bad()</script> https://example.com/ok');
  assert.doesNotMatch(hostile, /<script>/);
  assert.match(hostile, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(hostile, /<a href="https:\/\/example\.com\/ok">https:\/\/example\.com\/ok<\/a>/);
  assert.equal(
    draftBodyToHtml("(see https://a.com/x)"),
    '<div dir="ltr"><div>(see <a href="https://a.com/x">https://a.com/x</a>)</div></div>',
  );
});

test("signatureHtmlToText keeps readable breaks, decodes entities, and drops images", () => {
  assert.equal(
    signatureHtmlToText(
      '<div class="gmail_signature">Best,<br><br>Alex &amp; Co<div>Edge&nbsp;AI</div><img src="https://example.com/sig.png"></div>',
    ),
    "Best,\n\nAlex & Co\nEdge AI",
  );
  assert.equal(signatureHtmlToText("<div>&#65;&#x1F44B; &lt;hello&gt;</div>"), "A👋 <hello>");
});
