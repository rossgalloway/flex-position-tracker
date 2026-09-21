const REPORT_STYLES = `
  :root {
    color-scheme: light;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  * { box-sizing: border-box; }

  body {
    color: #0a0a0a;
    margin: 0;
    background: #fff;
  }

  .report {
    margin: 0 auto;
    max-width: 1120px;
    padding: 48px;
  }

  .report-header {
    align-items: start;
    border-bottom: 1px solid #d9d9d9;
    display: flex;
    justify-content: space-between;
    padding-bottom: 28px;
  }

  .report-kicker,
  .position-state,
  .eyebrow,
  dt,
  small,
  .formula span,
  .activity-date,
  .position-footer p span {
    color: #777;
  }

  .report-kicker,
  .position-state,
  .eyebrow,
  .activity-date,
  .activity-event > a,
  .formula,
  dd,
  .statement-rows strong,
  .statement-total strong {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .report-kicker,
  .eyebrow {
    font-size: 10px;
    letter-spacing: .1em;
    margin: 0 0 10px;
    text-transform: uppercase;
  }

  .report-header h1 {
    font-size: 28px;
    line-height: 1.15;
    margin: 0 0 8px;
  }

  .position-state {
    font-size: 11px;
    margin: 0;
  }

  .headline-metrics {
    border-bottom: 1px solid #d9d9d9;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: 0;
    padding: 22px 0;
  }

  .headline-metrics > div {
    min-width: 0;
    padding: 0 18px;
  }

  .headline-metrics > div:first-child { padding-left: 0; }
  .headline-metrics > div + div { border-left: 1px solid #e5e5e5; }

  dt {
    font-size: 11px;
    margin-bottom: 12px;
  }

  dd {
    font-size: 15px;
    margin: 0;
  }

  .position-summary-section,
  .activity,
  .projection-section {
    border-bottom: 1px solid #d9d9d9;
    padding: 32px 0;
  }

  .section-heading {
    margin-bottom: 20px;
  }

  .section-heading h3 {
    font-size: 18px;
    margin: 0;
  }

  .statement-rows,
  .activity-timeline {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .statement-rows {
    border-bottom: 1px solid #d9d9d9;
    border-top: 1px solid #d9d9d9;
  }

  .statement-rows li {
    align-items: baseline;
    border-top: 1px solid #ededed;
    display: grid;
    gap: 8px 20px;
    grid-template-columns: minmax(180px, .8fr) minmax(240px, 1.25fr) minmax(150px, auto);
    padding: 13px 0;
  }

  .statement-rows li:first-child { border-top: 0; }
  .statement-rows span { font-size: 12px; font-weight: 700; }
  .statement-rows small { font-size: 10px; }
  .statement-rows strong { font-size: 12px; text-align: right; }
  .statement-rows .is-detail > span { color: #777; padding-left: 24px; }
  .statement-rows .is-detail > strong { color: #444; font-weight: 500; }
  .statement-rows .is-result { border-top-color: #d9d9d9; }

  .statement-total {
    align-items: baseline;
    display: flex;
    justify-content: space-between;
    padding-top: 20px;
  }

  .statement-total span { font-size: 15px; font-weight: 700; }
  .statement-total strong { font-size: 16px; }

  .activity-event {
    align-items: start;
    border-top: 1px solid #ededed;
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(150px, .45fr) minmax(0, 1fr) auto;
    padding: 14px 0;
  }

  .activity-marker { display: none; }
  .activity-date,
  .activity-copy { display: grid; gap: 4px; }
  .activity-date, .activity-copy span, .activity-copy small { font-size: 10px; }
  .activity-copy strong { font-size: 12px; }
  .activity-event > a { color: #555; text-decoration: none; }

  .projection-metrics {
    border-bottom: 1px solid #ededed;
    border-top: 1px solid #ededed;
    margin: 0 0 24px;
  }

  .projection-metrics > div {
    align-items: baseline;
    border-top: 1px solid #ededed;
    display: grid;
    gap: 8px 20px;
    grid-template-columns: minmax(180px, .8fr) minmax(240px, 1fr) minmax(130px, auto);
    padding: 13px 0;
  }

  .projection-metrics > div:first-child { border-top: 0; }
  .projection-metrics dt { margin: 0; }
  .projection-metrics dd { grid-column: 3; grid-row: 1; text-align: right; }
  .projection-metrics small { grid-column: 2; grid-row: 1; font-size: 10px; }

  .formula {
    border-top: 1px solid #ededed;
    display: grid;
    gap: 6px;
    padding: 14px 0;
  }

  .formula span { font-size: 10px; text-transform: uppercase; }
  .formula code { font-size: 10px; white-space: normal; }

  .position-footer {
    align-items: start;
    display: flex;
    gap: 24px;
    justify-content: space-between;
    padding-top: 28px;
  }

  .position-footer p { display: grid; gap: 5px; margin: 0; }
  .position-footer p strong { font-size: 11px; }
  .position-footer p span { font-size: 10px; }
  .position-footer nav { display: flex; flex-wrap: wrap; gap: 12px; justify-content: end; }
  .position-footer a { color: #555; font-size: 10px; }

  @media (max-width: 720px) {
    .report { padding: 24px; }
    .headline-metrics { grid-template-columns: 1fr 1fr; }
    .headline-metrics > div:nth-child(3) { border-left: 0; padding-left: 0; }
    .headline-metrics > div:nth-child(n + 3) { border-top: 1px solid #ededed; padding-top: 18px; }
    .statement-rows li,
    .projection-metrics > div { grid-template-columns: minmax(0, 1fr) auto; }
    .statement-rows small,
    .projection-metrics small { grid-column: 1 / -1; grid-row: 2; }
    .projection-metrics dd { grid-column: 2; }
  }

  @page { size: A4 landscape; margin: 14mm; }

  @media print {
    .report { max-width: none; padding: 0; }
    .report-header, .headline-metrics, .statement-rows li, .activity-event,
    .projection-metrics > div, .formula, .position-footer {
      break-inside: avoid;
    }
    a { color: inherit; text-decoration: none; }
  }
`;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function statementExportFilename({ title, kicker }, extension) {
  const slug = `${title}-${kicker}`
    .toLowerCase()
    .replaceAll("…", "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
  return `flex-${slug || "position-statement"}.${extension}`;
}

export function buildFlexStatementDocument({ title, kicker, status, contentHtml }) {
  const documentTitle = `${title} — ${kicker}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(documentTitle)}</title>
  <style>${REPORT_STYLES}</style>
</head>
<body>
  <article class="report">
    <header class="report-header">
      <div>
        <p class="report-kicker">${escapeHtml(kicker)}</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="position-state">${escapeHtml(status)}</p>
      </div>
    </header>
    <main class="position-expanded">${contentHtml}</main>
  </article>
</body>
</html>`;
}
