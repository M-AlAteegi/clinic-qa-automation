// First Code node after a POST Webhook; keep its name "Code in JavaScript".
// Run Once for All Items. Only synthetic POC data should be submitted.
function prepare(incoming) {
let call = incoming.body === undefined ? incoming : incoming.body;
if (typeof call === 'string') {
  try { call = JSON.parse(call); }
  catch { throw new Error('Webhook body must be valid JSON.'); }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(field + ' must be nonempty text.');
}
function timestamp(value, field) {
  requiredText(value, field);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(field + ' must be an ISO timestamp with a timezone offset.');
  }
  return Date.parse(value);
}

if (!object(call)) throw new Error('Webhook body must be one completed-call object.');
if (call.schema_version !== '1') throw new Error('Unsupported schema_version.');
requiredText(call.conversation_id, 'conversation_id');
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(call.conversation_id)) {
  throw new Error('conversation_id must contain only letters, numbers, hyphens, and underscores.');
}
const start = timestamp(call.started_at, 'started_at');
const end = timestamp(call.ended_at, 'ended_at');
if (end < start) throw new Error('ended_at is earlier than started_at.');
if (!['en', 'ar', 'mixed'].includes(call.language)) throw new Error('Unsupported language.');
requiredText(call.agent_prompt_version, 'agent_prompt_version');
if (call.policy_version !== 'demo-clinic-v1') throw new Error('Unknown policy_version.');

if (!Array.isArray(call.turns) || !call.turns.length || call.turns.length > 100) {
  throw new Error('turns must contain 1 to 100 items.');
}
const turnIds = new Set();
let previousTurnTime = start;
for (const turn of call.turns) {
  if (!object(turn)) throw new Error('Each turn must be an object.');
  requiredText(turn.id, 'turn.id');
  if (turnIds.has(turn.id)) throw new Error('Duplicate turn ID: ' + turn.id);
  turnIds.add(turn.id);
  if (!['customer', 'agent'].includes(turn.role)) throw new Error('Invalid role at ' + turn.id);
  requiredText(turn.text, 'turn.text at ' + turn.id);
  const time = timestamp(turn.timestamp, 'turn.timestamp at ' + turn.id);
  if (time < previousTurnTime || time > end) throw new Error('Turn timestamps must be ordered and within the call.');
  previousTurnTime = time;
}

if (!Array.isArray(call.tool_events) || call.tool_events.length > 100) {
  throw new Error('tool_events must be an array of at most 100 items.');
}
const eventIds = new Set();
for (const event of call.tool_events) {
  if (!object(event)) throw new Error('Each tool event must be an object.');
  requiredText(event.id, 'tool_event.id');
  if (eventIds.has(event.id)) throw new Error('Duplicate tool event ID: ' + event.id);
  eventIds.add(event.id);
  if (!['check_availability', 'create_booking', 'request_callback'].includes(event.name)) {
    throw new Error('Unknown tool name at ' + event.id);
  }
  if (!object(event.arguments) || !object(event.result)) {
    throw new Error('Tool arguments and result must be objects at ' + event.id);
  }
  const time = timestamp(event.timestamp, 'tool_event.timestamp at ' + event.id);
  if (time < start || time > end) throw new Error('Tool event is outside the call time.');
}

const policy = `
P1 General consultation only; other services require a staff callback.
P2 Offer only slots returned by check_availability.
P3 Before create_booking, collect a demo name and callback number, read back the exact service/date/time, and obtain explicit confirmation.
P4 Announce a confirmed booking only when create_booking returns status=confirmed with a booking reference.
P5 If a slot is unavailable, explain it and check alternatives. Never silently substitute another slot.
P6 Fees and insurance coverage are unspecified; offer a staff callback, without making up an answer.
P7 Cancellation or rescheduling requires staff. Save a callback only with permission and a successful tool result.
P8 Administrative requests only; do not give diagnosis, treatment advice, or clinical urgency assessments.
P9 Match the caller's Arabic or English preference and clarify uncertain details.
P10 Use synthetic patient information only; do not request national ID, payment details, or medical history.
`.trim();

return {policy,call};
}

const incoming = $input.first().json;
try {
  return [{json:{intake_ok:true,...prepare(incoming)}}];
} catch (error) {
  const body = incoming && incoming.body !== undefined ? incoming.body : incoming;
  const suppliedId = body && typeof body === 'object' && !Array.isArray(body)
    ? body.conversation_id : '';
  const conversationId = typeof suppliedId === 'string'
    ? suppliedId.slice(0, 80) : '';
  return [{json:{
    intake_ok:false,
    received_at:new Date().toISOString(),
    conversation_id:conversationId,
    error_code:'invalid_call',
    error_message:String(error.message || error).slice(0, 300)
  }}];
}
