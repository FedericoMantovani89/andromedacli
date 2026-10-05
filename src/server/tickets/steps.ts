import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitStep } from '../git/commit';
import { git } from '../git/git';
import { pushBranch } from '../git/push';
import { validateChecklist, type ChecklistError, type Step } from './checklist';
import type { TicketStore } from './store';
import { runValidation } from './validate';

export type StepRefusal =
  | 'out_of_order' | 'no_checklist' | 'no_worktree' | 'note_required' | 'secrets' | 'index_locked' | 'commit_failed'
  | 'validation_failed' | 'no_test_command' | 'docs_empty' | 'already_delivered';

export type StepResult =
  | { status: 'closed'; n: number; total: number; sha?: string; delivered?: boolean; pushed?: boolean; pushNote?: string }
  | { status: 'refused'; code: StepRefusal; detail?: string; tail?: string; files?: string[]; timedOut?: boolean };

export type ChecklistSetResult =
  | { status: 'ok'; steps: Step[] }
  | { status: 'refused'; code: ChecklistError | 'no_worktree' | 'already_delivered'; detail: string };

export interface StepDeps {
  tickets: TicketStore;
  plan: string;
  worktreeOf(slug: string): { worktree: string; branch: string } | undefined;
  testCommand(): string | undefined;
  testTimeoutMs(): number;
  secretPatterns(): string[];
  /** Tells the main session (inbox). */
  notifyMain(slug: string, text: string): void;
  /** Something visible changed (progress, blocked flag): the state is pushed to the UI. */
  changed(): void;
  /**
   * A step was closed (after the ticket was updated). `skipped`: closed with skip; `empty`: its commit changed no file. Neither is
   * progress for the loop handling.
   */
  stepClosed?(slug: string, o: { skipped: boolean; empty: boolean }): void;
}

const MIN_STUDY_NOTE = 10;
const MIN_DOCS_NOTE = 10;
const MIN_SKIP_NOTE = 20;
const refuse = (code: StepRefusal, extra: Omit<Extract<StepResult, { status: 'refused' }>, 'status' | 'code'> = {}): StepResult => ({ status: 'refused', code, ...extra });

/**
 * The ticket flow behind `checklist_set`, `step_done` and `report_blocked` (SPEC 8). The console, not the agent, commits, runs the
 * validation and pushes. Calls for one agent are serialised, so a repeated or concurrent `step_done` can never commit twice.
 */
export class StepService {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly d: StepDeps) {}

  private serial<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(slug) ?? Promise.resolve()).then(fn, fn);
    this.chains.set(slug, run.catch(() => undefined));
    return run;
  }

  checklistSet(slug: string, items: string[]): Promise<ChecklistSetResult> {
    return this.serial(slug, async () => {
      const wt = this.d.worktreeOf(slug);
      if (!wt) return { status: 'refused', code: 'no_worktree', detail: 'this agent has no worktree' };
      const ticket = this.d.tickets.get(slug);
      if (ticket && ticket.status !== 'in_progress') return { status: 'refused', code: 'already_delivered', detail: 'the ticket was already delivered' };
      const v = validateChecklist(items, ticket?.steps);
      if (!v.ok) return { status: 'refused', code: v.code, detail: v.detail };
      this.d.tickets.setChecklist(slug, v.steps);
      this.writeChecklistFile(slug, wt.worktree, v.steps);
      this.d.changed();
      return { status: 'ok', steps: v.steps };
    });
  }

  stepDone(slug: string, o: { n: number; note?: string; skip?: boolean }): Promise<StepResult> {
    return this.serial(slug, () => this.close(slug, o));
  }

  reportBlocked(slug: string, reason: string): void {
    this.d.tickets.block(slug, reason);
    this.d.notifyMain(slug, `Agent "${slug}" is blocked and waiting for you: ${reason}`);
    this.d.changed();
  }

  private async close(slug: string, o: { n: number; note?: string; skip?: boolean }): Promise<StepResult> {
    const wt = this.d.worktreeOf(slug);
    if (!wt) return refuse('no_worktree', { detail: 'this agent has no worktree' });
    const ticket = this.d.tickets.get(slug);
    if (!ticket || ticket.steps.length === 0) return refuse('no_checklist', { detail: 'call checklist_set first' });
    if (ticket.status !== 'in_progress') return refuse('already_delivered', { detail: 'every step is closed and the branch was delivered' });
    const next = ticket.steps.find((s) => !s.done);
    if (!next || next.n !== o.n) return refuse('out_of_order', { detail: next ? `the next open step is ${next.n}` : 'every step is closed' });

    const total = ticket.steps.length;
    const note = (o.note ?? '').trim();
    const isValidation = o.n === total - 1;
    const isDocs = o.n === total;

    if (o.skip) {
      if (isValidation) return refuse('validation_failed', { detail: 'the validation step cannot be skipped' });
      if (note.length < MIN_SKIP_NOTE) return refuse('note_required', { detail: `skipping a step needs a written reason of at least ${MIN_SKIP_NOTE} characters` });
    } else if (o.n === 1 && note.length < MIN_STUDY_NOTE) {
      return refuse('note_required', { detail: 'step 1 needs a note with what you found (files, conventions, risks)' });
    }

    if (isValidation) {
      const command = this.d.testCommand()?.trim();
      if (!command) return refuse('no_test_command', { detail: 'the plan has no test command: ask the main to set it in the console options' });
      const v = await runValidation({ cwd: wt.worktree, command, timeoutMs: this.d.testTimeoutMs() });
      if (!v.ok) return refuse('validation_failed', { tail: v.tail, ...(v.timedOut ? { timedOut: true, detail: 'the test command timed out and was stopped' } : { detail: `the test command exited with code ${v.code}` }) });
    }

    if (isDocs && !o.skip && note.length < MIN_DOCS_NOTE) {
      const status = await git(wt.worktree, ['status', '--porcelain']);
      if (status.stdout.trim() === '') return refuse('docs_empty', { detail: `the documentation step needs a change, or a note of at least ${MIN_DOCS_NOTE} characters saying why none is needed` });
    }

    // A crash between the commit and the ticket update leaves the commit in git but the step open: adopt it instead of committing twice.
    const adopted = await this.existingCommit(wt.worktree, o.n, total, next.title, slug);
    const commit = adopted ?? await commitStep({
      worktree: wt.worktree, n: o.n, total, title: next.title, slug, plan: this.d.plan, secretPatterns: this.d.secretPatterns(),
    });
    if (!commit.ok) {
      if (commit.code === 'secrets') return refuse('secrets', { files: commit.files, detail: 'these files look like secrets and were left out: remove them or add them to .gitignore' });
      if (commit.code === 'index_locked') return refuse('index_locked', { detail: 'git is busy (index.lock): try again in a moment' });
      return refuse('commit_failed', { detail: commit.detail });
    }

    const updated = this.d.tickets.markDone(slug, o.n, { note: note || undefined, sha: commit.sha, skipped: o.skip });
    if (updated.blocked) this.d.tickets.unblock(slug);
    if (this.d.stepClosed) {
      const empty = await this.emptyCommit(wt.worktree);
      try { this.d.stepClosed(slug, { skipped: o.skip === true, empty }); } catch { /* the step is closed whatever the loop bookkeeping does */ }
    }
    this.writeChecklistFile(slug, wt.worktree, updated.steps);

    if (!isDocs) {
      this.d.changed();
      return { status: 'closed', n: o.n, total, sha: commit.sha };
    }
    const push = await pushBranch({ worktree: wt.worktree, branch: wt.branch });
    this.d.tickets.move(slug, 'delivered', { deliveredSha: commit.sha });
    const pushText = !push.ok ? `push failed (${push.detail})` : 'skipped' in push ? 'not pushed (no remote configured)' : 'pushed to origin';
    this.d.notifyMain(slug, `Ticket "${slug}" delivered: branch ${wt.branch}, ${total} commits, ${pushText}. Review is next.`);
    this.d.changed();
    return {
      status: 'closed', n: o.n, total, sha: commit.sha, delivered: true,
      pushed: push.ok && !('skipped' in push), ...(push.ok ? ('skipped' in push ? { pushNote: 'no_remote' } : {}) : { pushNote: push.detail }),
    };
  }

  /** The tip commit has the same tree as its parent (it changed no file). A root commit, or git failing, counts as not empty. */
  private async emptyCommit(worktree: string): Promise<boolean> {
    const trees = await git(worktree, ['rev-parse', 'HEAD^{tree}', 'HEAD~1^{tree}']);
    if (trees.code !== 0) return false;
    const [head, parent] = trees.stdout.trim().split(/\r?\n/);
    return head !== undefined && head !== '' && head === parent;
  }

  /** The console's own commit for this very step, if it is already the tip of the branch. */
  private async existingCommit(worktree: string, n: number, total: number, title: string, slug: string): Promise<{ ok: true; sha: string } | undefined> {
    const head = await git(worktree, ['log', '-1', '--format=%H%n%s%n%b']);
    if (head.code !== 0) return undefined;
    const [sha, subject, ...body] = head.stdout.split(/\r?\n/);
    const expected = `step ${n}/${total}: ${title.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    return sha && subject === expected && body.join('\n').includes(`Agent: ${slug}`) ? { ok: true, sha } : undefined;
  }

  /** The checklist as a file in the worktree (SPEC 8.4): it survives a compaction of the agent's context. */
  private writeChecklistFile(slug: string, worktree: string, steps: Step[]): void {
    const lines = steps.map((s) => `- [${s.done ? 'x' : ' '}] ${s.n}. ${s.title}${s.skipped ? ' (skipped)' : ''}${s.note ? ` — ${s.note.replace(/\s+/g, ' ')}` : ''}`);
    try {
      mkdirSync(join(worktree, '.console'), { recursive: true });
      writeFileSync(join(worktree, '.console', 'checklist.md'), `---\nticket: ${slug}\n---\n${lines.join('\n')}\n`, 'utf8');
    } catch { /* the ticket store is the record; the file is a convenience for the agent */ }
  }
}
