// n8n Code node after "Get QA Results" and "Get Intake Errors".
// Run Once for All Items. Set a YYYY-MM-DD preview date only for manual backfills.
const PREVIEW_DATE = '';
const TIMEZONE = 'Asia/Riyadh';

function localDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function previousLocalDate() {
  const today = localDate(new Date());
  const date = new Date(today + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function rowsFrom(nodeName) {
  return $(nodeName).all().map(item => item.json).filter(row =>
    row && typeof row === 'object' && Object.keys(row).length > 0);
}

const reportDate = PREVIEW_DATE || previousLocalDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error('Invalid report date.');
const qaRows = rowsFrom('Get QA Results').filter(row =>
  row.conversation_id && localDate(row.evaluated_at) === reportDate);
const errorRows = rowsFrom('Get Intake Errors').filter(row =>
  localDate(row.received_at) === reportDate);

// Count each conversation once even if an old evaluator version remains in the table.
const latestByConversation = new Map();
for (const row of qaRows) {
  const previous = latestByConversation.get(row.conversation_id);
  if (!previous || Date.parse(row.evaluated_at) > Date.parse(previous.evaluated_at)) {
    latestByConversation.set(row.conversation_id, row);
  }
}
const evaluations = [...latestByConversation.values()];
const counts = {
  evaluated_calls: evaluations.length,
  validated: 0,
  needs_review: 0,
  supported: 0,
  contradicted: 0,
  insufficient_evidence: 0,
  intake_errors: errorRows.length
};
const categories = new Map();
const recommendations = new Map();
const reviewIds = [];

for (const row of evaluations) {
  let parsed;
  try { parsed = JSON.parse(row.result_json); }
  catch { parsed = null; }
  const qa = parsed && typeof parsed === 'object' ? (parsed.qa || parsed) : null;
  if (row.status !== 'validated' || !qa ||
      !['supported', 'contradicted', 'insufficient_evidence'].includes(row.verdict)) {
    counts.needs_review++;
    reviewIds.push(row.conversation_id);
    continue;
  }
  counts.validated++;
  counts[row.verdict]++;
  if (row.verdict === 'supported') continue;
  for (const finding of Array.isArray(qa.findings) ? qa.findings : []) {
    const category = oneLine(finding.category) || 'uncategorized';
    if (!categories.has(category)) categories.set(category, new Set());
    categories.get(category).add(row.conversation_id);
  }
  const recommendation = oneLine(qa.recommended_prompt_change);
  if (recommendation && recommendation !== 'No prompt change needed.') {
    if (!recommendations.has(recommendation)) recommendations.set(recommendation, new Set());
    recommendations.get(recommendation).add(row.conversation_id);
  }
}

const lines = [
  `# Clinic QA report — ${reportDate}`,
  '',
  `Generated: ${new Date().toISOString()} · Reporting timezone: ${TIMEZONE}`,
  'Day assignment uses the QA evaluation time and intake-error receipt time.',
  '',
  '## Counts',
  '',
  '| Metric | Count |',
  '| --- | ---: |',
  `| Unique evaluated calls | ${counts.evaluated_calls} |`,
  `| Validated evaluations | ${counts.validated} |`,
  `| Supported | ${counts.supported} |`,
  `| Contradicted | ${counts.contradicted} |`,
  `| Insufficient evidence | ${counts.insufficient_evidence} |`,
  `| Evaluations needing review | ${counts.needs_review} |`,
  `| Rejected intake submissions | ${counts.intake_errors} |`,
  '',
  '## Finding categories',
  ''
];
if (!categories.size) lines.push('None in validated problem evaluations.');
else for (const [category, ids] of [...categories].sort((a, b) => b[1].size - a[1].size)) {
  lines.push(`- **${category}**: ${ids.size} call(s) — ${[...ids].sort().join(', ')}`);
}
lines.push('', '## Proposed prompt changes', '');
if (!recommendations.size) lines.push('No prompt changes proposed from validated findings.');
else for (const [recommendation, ids] of recommendations) {
  lines.push(`- ${recommendation} (from ${[...ids].sort().join(', ')})`);
}
lines.push('', '## Processing and review queue', '');
lines.push(`- Evaluations needing review: ${reviewIds.length ? reviewIds.sort().join(', ') : 'none'}`);
lines.push(`- Rejected intake submissions: ${errorRows.length ? errorRows.map(row =>
  `${oneLine(row.conversation_id) || 'unknown ID'} (${oneLine(row.error_code) || 'unknown error'})`).join(', ') : 'none'}`);
lines.push('', 'Recommendations are drafts for human review; this workflow does not edit the agent prompt.');

return [{json:{
  report_date: reportDate,
  file_name: `clinic-qa-${reportDate}.md`,
  generated_at: new Date().toISOString(),
  counts,
  markdown: lines.join('\n') + '\n'
}}];
