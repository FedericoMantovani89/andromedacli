import { writeJsonAtomic } from '../fs-atomic';
import { readJsonState, setAside, type StateReport } from '../json-file';
import type { EscalationReason, RequestState } from '../../shared/requests';

export interface RequestRecord {
  id: string;
  from: string;
  to: string;
  text: string;
  state: RequestState;
  /** Depth of the chain this request belongs to (0 for a first question; SPEC 10.1 rule 6). */
  hops: number;
  /** The request this one was needed for. */
  parent?: string;
  createdAt: number;
  /** The inbox message that carries the question: its acknowledgement starts the clock. */
  messageId?: string;
  deliveredAt?: number;
  /** When an open request goes to the main; absent for a request to the main and after an escalation. */
  deadline?: number;
  escalatedBy?: EscalationReason;
}

const STATES: RequestState[] = ['open', 'escalated', 'answered', 'cancelled'];
const isRecord = (v: unknown): v is RequestRecord => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.from === 'string' && typeof r.to === 'string' && typeof r.text === 'string'
    && STATES.includes(r.state as RequestState) && typeof r.hops === 'number' && typeof r.createdAt === 'number';
};

/** The requests of one project, written through to `state/requests.json` on every change so a restart keeps them. */
export class RequestStore {
  private readonly items = new Map<string, RequestRecord>();

  constructor(private readonly file?: string, private readonly report?: StateReport) {}

  /** Reads the saved file (before anything is added). A missing or damaged file means no requests; a damaged record is skipped. */
  load(): void {
    if (!this.file) return;
    const s = readJsonState(this.file, this.report);
    if (s.status !== 'ok') return;
    if (!Array.isArray(s.value)) { setAside(this.file, this.report); return; }
    for (const r of s.value) if (isRecord(r)) this.items.set(r.id, r);
  }

  get(id: string): RequestRecord | undefined { return this.items.get(id); }
  list(): RequestRecord[] { return [...this.items.values()]; }

  add(r: RequestRecord): void {
    this.items.set(r.id, r);
    this.save();
  }

  /** Merges `patch` into the record; a field set to `undefined` is removed. Returns the new record, or undefined for an unknown id. */
  update(id: string, patch: { [K in keyof RequestRecord]?: RequestRecord[K] | undefined }): RequestRecord | undefined {
    const current = this.items.get(id);
    if (!current) return undefined;
    const merged: Record<string, unknown> = { ...current, ...patch };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    const next = merged as unknown as RequestRecord;
    this.items.set(id, next);
    this.save();
    return next;
  }

  private save(): void {
    if (!this.file) return;
    try { writeJsonAtomic(this.file, [...this.items.values()]); } catch { /* a state that cannot be saved still works in this run */ }
  }
}
