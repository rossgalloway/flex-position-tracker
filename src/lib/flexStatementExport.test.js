import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFlexStatementDocument,
  statementExportFilename,
} from "./flexStatementExport.js";

test("builds a standalone printable Flex statement", () => {
  const document = buildFlexStatementDocument({
    title: "ysyBOLD / USDC",
    kicker: "0x4449…8f8100 · Trove 2 of 2",
    status: "Closed · block 25,897,639",
    contentHtml: '<section class="position-summary-section">Report rows</section>',
  });

  assert.match(document, /^<!doctype html>/);
  assert.match(document, /<title>ysyBOLD \/ USDC — 0x4449…8f8100 · Trove 2 of 2<\/title>/);
  assert.match(document, /@page \{ size: A4 landscape;/);
  assert.match(document, /<section class="position-summary-section">Report rows<\/section>/);
  assert.doesNotMatch(document, /data-statement-close/);
});

test("escapes statement metadata and creates a stable export filename", () => {
  const document = buildFlexStatementDocument({
    title: "<Vault> & USDC",
    kicker: "0x1234…5678",
    status: 'Active "now"',
    contentHtml: "<p>Known report content</p>",
  });

  assert.match(document, /&lt;Vault&gt; &amp; USDC/);
  assert.match(document, /Active &quot;now&quot;/);
  assert.equal(
    statementExportFilename({ title: "ysyBOLD / USDC", kicker: "0x4449…8f8100 · Trove 2 of 2" }, "html"),
    "flex-ysybold-usdc-0x4449-8f8100-trove-2-of-2.html",
  );
});
