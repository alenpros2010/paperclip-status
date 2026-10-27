import { type Config, type Get, StatusError } from './client.js';

type Row = Record<string, unknown>;
export type Section = { name: 'overview' | 'costs' | 'approvals' | 'activity'; lines: string[]; partial: boolean; error?: string; omitted: number };
export type Snapshot = { timestamp: string; reportingTimezone: 'UTC'; sections: Section[]; atomic: false };
const row = (v: unknown): Row => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new StatusError('invalid_response'); return v as Row; };
const list = (v: unknown): Row[] => { if (!Array.isArray(v)) throw new StatusError('invalid_response'); return v.map(row); };
export function safe(v: unknown, max = 80): string {
  return (typeof v === 'string' || typeof v === 'number' ? String(v) : 'unknown').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/[<>&@*_`\[\]{}()\\#|!~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || 'unknown';
}
export function date(v: unknown): string { return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : 'unknown'; }
export function monthBounds(now: Date): { from: string; to: string } {
  return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), to: now.toISOString() };
}
export function amount(exact: unknown, rounded: unknown, currency?: string): string {
  let cents: string;
  if (typeof exact === 'string' && /^\d{1,30}(?:\.\d{1,20})?$/.test(exact)) cents = exact;
  else if (exact !== undefined && exact !== null) return 'unknown';
  else if (typeof rounded === 'number' && Number.isFinite(rounded) && rounded >= 0 && rounded <= Number.MAX_SAFE_INTEGER) cents = String(rounded);
  else return 'unknown';
  if (!currency) return `${cents} cents (currency unconfirmed)`;
  const [whole = '0', fractional = ''] = cents.split('.');
  // Decimal point shift, not integer truncation or binary floating-point conversion.
  const padded = whole.padStart(3, '0');
  return `${padded.slice(0, -2).replace(/^0+(?=\d)/, '')}.${padded.slice(-2)}${fractional} ${currency}`;
}
// Source-only issue-run shape: fixture utility, NEVER a runtime request or a company-latest source.
export function normalizeIssueRuns(input: unknown): { runId: string; agentId: string; status: string; createdAt: string; startedAt: string; finishedAt: string }[] {
  return list(input).map(r => ({ runId: safe(r.runId), agentId: safe(r.agentId), status: safe(r.status), createdAt: date(r.createdAt), startedAt: date(r.startedAt), finishedAt: date(r.finishedAt) })).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.runId.localeCompare(b.runId));
}
function section(name: Section['name'], lines: string[], partial = true, omitted = 0): Section { return { name, lines, partial, omitted }; }
function errorSection(name: Section['name'], err: unknown): Section { return { ...section(name, []), error: err instanceof StatusError ? err.code : 'invalid_response' }; }
export async function snapshot(c: Config, get: Get, signal: AbortSignal, now = new Date(), secret = ''): Promise<Snapshot> {
  const scrub = (r: Row): Row => Object.fromEntries(Object.entries(r).map(([key, value]) => [key, typeof value === 'string' && secret ? value.split(secret).join('[redacted]') : value]));
  const label = (value: unknown, max = 80) => safe(value, max);
  const prefix = `/api/companies/${c.companyId}/`;
  const bounds = new URLSearchParams(monthBounds(now)).toString();
  // Exactly four requests in flight; by-agent is dependent on summary completion.
  const overview = async () => {
    try {
      const agents = list(await get(`${prefix}agents`, signal)).map(scrub);
      return section('overview', [`Agents visible: ${agents.length}; latest runs: unknown (safe run endpoint not verified)`, ...agents.slice(0, 100).map(a => `${label(a.name)} [${label(a.id, 36)}] · roster=${label(a.status)} · latest run=unknown`)], true, Math.max(0, agents.length - 100));
    } catch (e) { return errorSection('overview', e); }
  };
  const costs = async () => {
    const lines = [`MTD: ${monthBounds(now).from} through ${now.toISOString()} inclusive; reporting UTC`];
    let summaryFailed = false;
    try {
      const s = scrub(row(await get(`${prefix}costs/summary?${bounds}`, signal)));
      if (s.companyId !== c.companyId) throw new StatusError('invalid_response');
      lines.push(`Company total: ${amount(s.spendCentsExact, s.spendCents, c.currency)}`);
      lines.push(`Pricing complete=${safe(s.pricingComplete === true ? 'yes' : s.pricingComplete === false ? 'no' : 'unknown')}; estimated=${safe(s.estimatedEventCount)}; unpriced=${safe(s.unpricedEventCount)}; pending accounting=${safe(s.pendingAccountingEventCount)}`);
    } catch (e) { summaryFailed = true; lines.push(`Company total unavailable: ${e instanceof StatusError ? e.code : 'invalid_response'}`); }
    try {
      const agents = list(await get(`${prefix}costs/by-agent?${bounds}`, signal)).map(scrub);
      lines.push('Per-agent records only; missing row is unknown, not zero. Totals are not atomic or sprint spend.');
      lines.push(...agents.slice(0, 100).map(a => `${label(a.agentName)} [${label(a.agentId, 36)}]: ${amount(a.costCentsExact, a.costCents, c.currency)}; estimated=${label(a.estimatedEventCount)}`));
      return section('costs', lines, true, Math.max(0, agents.length - 100));
    } catch (e) {
      lines.push(`Per-agent costs unavailable: ${e instanceof StatusError ? e.code : 'invalid_response'}`);
      const result = section('costs', lines);
      if (summaryFailed) result.error = e instanceof StatusError ? e.code : 'invalid_response';
      return result;
    }
  };
  const approvals = async () => {
    try {
      const rows = list(await get(`${prefix}approvals?status=pending`, signal)).map(scrub);
      if (rows.some(r => r.status !== 'pending')) throw new StatusError('invalid_response');
      rows.sort((a, b) => date(b.createdAt).localeCompare(date(a.createdAt)) || label(a.id).localeCompare(label(b.id)));
      return section('approvals', [`Pending approvals visible: ${rows.length} (actor-scoped; not proof of global absence)`, ...rows.slice(0, 100).map(r => `${label(r.id, 12)} · ${label(r.type)} · ${date(r.createdAt)}`)], true, Math.max(0, rows.length - 100));
    } catch (e) { return errorSection('approvals', e); }
  };
  const activity = async () => {
    try {
      const rows = list(await get(`${prefix}activity?limit=10`, signal)).map(scrub);
      return section('activity', [`Recent activity visible: ${Math.min(10, rows.length)}; bounded feed, not run/cost authority`, ...rows.slice(0, 10).map(r => `${date(r.createdAt)} · ${label(r.action)} · ${label(r.entityType)} [${label(r.entityId, 36)}]`)], true, Math.max(0, rows.length - 10));
    } catch (e) { return errorSection('activity', e); }
  };
  return { timestamp: now.toISOString(), reportingTimezone: 'UTC', atomic: false, sections: await Promise.all([overview(), costs(), approvals(), activity()]) };
}
export function render(s: Snapshot, secret = '', maxChars = 3600): string {
  const redact = (value: string) => secret ? value.split(secret).join('[redacted]').split(safe(secret)).join('[redacted]') : value;
  const header = redact(`Paperclip snapshot ${s.timestamp}\nReporting timezone: UTC; independent reads, non-atomic. API labels are untrusted data.\n`);
  const budget = Math.floor((maxChars - header.length) / 4);
  const blocks = s.sections.map(sec => {
    const title = `${sec.name.toUpperCase()} · ${sec.error ?? (sec.partial ? 'partial / scoped' : 'complete')}\n`;
    const footer = `\nOmitted: ${sec.omitted}`;
    const lines: string[] = []; let used = title.length + footer.length + 65;
    for (const source of sec.lines) { const line = redact(source); if (used + line.length + 1 > budget) break; lines.push(line); used += line.length + 1; }
    const hidden = sec.lines.length - lines.length;
    return title + lines.join('\n') + footer + (hidden ? `; output omitted ${hidden} lines` : '');
  });
  return header + blocks.join('\n\n');
}
