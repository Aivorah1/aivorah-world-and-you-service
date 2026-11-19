// Approval history for Current Affairs (table ca_audit_log, aivorah-db
// 0029_current_affairs_audit_log.sql): who created, edited, approved,
// scheduled, rejected or archived which story or quiz question, and when.
//
// Writing history never blocks an editor's action: if the table is missing
// (migration not run yet) or the insert fails, the change still goes through
// and the problem is logged loudly so it can be fixed.
const { isNotSetUp } = require('./db');

// The service's Supabase client, loaded only when history is written or read:
// the pipeline scripts load this file before they check their settings.
const defaultClient = () => require('../../services/supabase');

const HISTORY_LIMIT = 100;

// The fields that differ between two snapshots, as { before, after } objects.
function changedFields(before = {}, after = {}, fields = Object.keys(after || {})) {
  const was = {};
  const now = {};
  for (const f of fields) {
    const a = before?.[f] ?? null;
    const b = after?.[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) { was[f] = a; now[f] = b; }
  }
  return { before: was, after: now, changed: Object.keys(now) };
}

/**
 * Adds one history row. entries: one object or an array of
 * { actor, action, entityType, entityId, before, after, detail }.
 * Resolves to true when saved, false otherwise (never throws).
 * `client` defaults to the service's Supabase client.
 */
async function record(entries, { client } = {}) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean).map((e) => ({
    actor: String(e.actor || 'unknown'),
    action: String(e.action),
    entity_type: String(e.entityType),
    entity_id: e.entityId || null,
    before: e.before ?? null,
    after: e.after ?? null,
    detail: e.detail ? String(e.detail).slice(0, 500) : null,
  }));
  if (!list.length) return true;
  try {
    const { error } = await (client || defaultClient()).from('ca_audit_log').insert(list);
    if (!error) return true;
    console.error(`[ca-audit] NOT RECORDED (${isNotSetUp(error) ? 'run aivorah-db 0029_current_affairs_audit_log.sql' : error.message}):`,
      list.map((l) => `${l.actor} ${l.action} ${l.entity_type}:${l.entity_id}`).join('; '));
  } catch (err) {
    console.error('[ca-audit] NOT RECORDED:', err.message);
  }
  return false;
}

/** The history of one story or question, newest first. { available, entries }. */
async function historyFor(entityType, entityId, { client } = {}) {
  const { data, error } = await (client || defaultClient()).from('ca_audit_log')
    .select('id, actor, action, before, after, detail, created_at')
    .eq('entity_type', entityType).eq('entity_id', entityId)
    .order('created_at', { ascending: false }).limit(HISTORY_LIMIT);
  if (error) {
    if (isNotSetUp(error)) return { available: false, entries: [] };
    throw error;
  }
  return { available: true, entries: data || [] };
}

module.exports = { record, historyFor, changedFields };
