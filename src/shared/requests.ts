/** Requests between agents (SPEC 10): wire types shared by the server and the browser UI. Codes are English constants (P11). */
export type RequestState = 'open' | 'escalated' | 'answered' | 'cancelled';
/** Why a request went to the main. */
export type EscalationReason = 'timeout' | 'unknown' | 'recipient_gone' | 'explicit';

/** `TODO-` plus six lowercase hex characters: also the text of the comment an agent leaves in the code. */
export const REQUEST_ID_RE = /^TODO-[0-9a-f]{6}$/;

/** One request as the Requests drawer shows it. Times are ISO strings. */
export interface RequestRow {
  id: string;
  from: string;
  to: string;
  state: RequestState;
  /** Who holds the request now: the recipient, or the main after an escalation. */
  handler: string;
  /** The question, cut to 300 characters. */
  text: string;
  hops: number;
  createdAt: string;
  /** When an open request goes to the main; absent when it has no timeout. */
  deadline?: string;
  escalatedBy?: EscalationReason;
}

/** What an agent's chip shows: steps waiting for an answer, and requests the agent still has to answer. */
export interface RequestsInfo {
  waiting: { id: string; to: string }[];
  owed: { id: string; from: string }[];
}
