// Second n8n Code node, after "Message a model". Run Once for All Items.
// Keep the first Code node named "Code in JavaScript" for this reference.
const source = $('Code in JavaScript').first().json;
const response = $input.first().json;
const call = source.call;
const problems = [];
const normalizations = [];

function collectText(value, output, depth) {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const part of value) collectText(part, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const key of ['output_text', 'text', 'content', 'output', 'message', 'data']) {
    if (key in value) collectText(value[key], output, depth + 1);
  }
}

const textCandidates = [];
collectText(response, textCandidates, 0);
let qa = null;
let rawModelText = '';
if (response && typeof response === 'object' && !Array.isArray(response)
    && typeof response.verdict === 'string') {
  qa = {...response};
}
if (!qa) {
  for (const candidate of textCandidates) {
    const cleaned = candidate.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          && typeof parsed.verdict === 'string') {
        qa = parsed;
        rawModelText = candidate;
        break;
      }
    } catch {
      // Try the next text field. A failed parse is recorded below if none work.
    }
  }
}
if (!qa) {
  problems.push('OpenAI output did not contain a JSON object with a verdict.');
  rawModelText = textCandidates[0] || JSON.stringify(response);
  qa = {};
}

const bookingEvents = Array.isArray(call.tool_events)
  ? call.tool_events.filter(event => event.name === 'create_booking') : [];
const lastBooking = bookingEvents.length ? bookingEvents[bookingEvents.length - 1] : null;
let actualBookingOutcome = 'not_attempted';
if (lastBooking) {
  actualBookingOutcome = 'not_confirmed';
  if (lastBooking.result && lastBooking.result.status === 'confirmed'
      && lastBooking.result.booking_reference) actualBookingOutcome = 'confirmed';
}

if (qa.conversation_id !== call.conversation_id) problems.push('Model conversation_id does not match the call.');
if (!['supported', 'contradicted', 'insufficient_evidence'].includes(qa.verdict)) {
  problems.push('Model verdict is missing or invalid.');
}
if (qa.booking_outcome !== actualBookingOutcome) {
  problems.push('Model booking_outcome disagrees with the create_booking tool result.');
}
if (!Array.isArray(qa.findings)) {
  problems.push('Model findings is not an array.');
}

const turns = new Map((call.turns || []).map(turn => [turn.id, turn]));
const events = new Map((call.tool_events || []).map(event => [event.id, event]));
const policyIds = new Set(source.policy.split('\n').map(line => {
  const match = line.trim().match(/^(P\d+)\b/);
  return match ? match[1] : '';
}));
const findings = [];
for (const [index, original] of (Array.isArray(qa.findings) ? qa.findings : []).entries()) {
  if (!original || typeof original !== 'object' || Array.isArray(original)) {
    problems.push('Finding ' + (index + 1) + ' is not an object.');
    continue;
  }
  const finding = {...original};
  const turn = turns.get(finding.turn_id);
  if (!turn || turn.role !== 'agent') {
    problems.push('Finding ' + (index + 1) + ' cites a missing or non-agent turn.');
  } else {
    const supplied = typeof finding.evidence === 'string' ? finding.evidence : '';
    const trimmed = supplied.trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, '');
    if (trimmed && !turn.text.includes(trimmed)) {
      problems.push('Finding ' + (index + 1) + ' model evidence does not match its cited turn.');
    }
    if (supplied !== turn.text) {
      normalizations.push({finding_index:index + 1, turn_id:finding.turn_id,
        model_evidence:supplied, exact_evidence:turn.text});
    }
    finding.evidence = turn.text;
  }
  if (typeof finding.category !== 'string' || !finding.category.trim()) {
    problems.push('Finding ' + (index + 1) + ' has no category.');
  }
  if (typeof finding.explanation !== 'string' || !finding.explanation.trim()) {
    problems.push('Finding ' + (index + 1) + ' has no explanation.');
  }
  if (finding.policy_id && !policyIds.has(finding.policy_id)) {
    problems.push('Finding ' + (index + 1) + ' cites an unknown policy ID.');
  }
  if (finding.tool_event_id && !events.has(finding.tool_event_id)) {
    problems.push('Finding ' + (index + 1) + ' cites an unknown tool event ID.');
  }
  findings.push(finding);
}

if (qa.verdict === 'supported' && findings.length) {
  problems.push('Supported verdict has problem findings.');
}
if (['contradicted', 'insufficient_evidence'].includes(qa.verdict) && !findings.length) {
  problems.push('Problem verdict has no findings.');
}
if (qa.verdict === 'supported') {
  qa.recommended_prompt_change = 'No prompt change needed.';
} else if (typeof qa.recommended_prompt_change !== 'string'
    || !qa.recommended_prompt_change.trim()) {
  problems.push('Problem verdict has no recommended prompt change.');
}

qa.conversation_id = call.conversation_id;
qa.booking_outcome = actualBookingOutcome;
qa.findings = findings;
const status = problems.length ? 'needs_review' : 'validated';
return [{json:{
  evaluation_key: call.conversation_id + ':qa-v1',
  conversation_id: call.conversation_id,
  evaluator_version: 'qa-v1',
  evaluated_at: new Date().toISOString(),
  status,
  verdict: ['supported', 'contradicted', 'insufficient_evidence'].includes(qa.verdict)
    ? qa.verdict : 'not_assessed',
  booking_outcome: actualBookingOutcome,
  finding_count: findings.length,
  result_json: JSON.stringify({qa, validation_problems:problems,
    evidence_normalizations:normalizations, raw_model_text:rawModelText}),
  qa,
  validation_problems: problems,
  evidence_normalizations: normalizations
}}];
