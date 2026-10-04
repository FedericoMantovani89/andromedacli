import { readFileSync } from 'node:fs';
import type { Translate } from '../../shared/i18n';
import { identityArgs } from '../git/commit';
import { git } from '../git/git';
import { changedFiles, ensurePlanWorktree, withPlanLock } from '../git/merge';
import { withReleaseToken } from '../git/release-hook';
import { reportPath, type ChangedFile } from './report';
import type { Ticket, TicketStore } from './store';
import { runValidation } from './validate';

export interface ReleaseDeps {
  tickets: TicketStore;
  /** The plan folder = the user's checkout, where `main` lives. */
  root: string;
  plan: string;
  testCommand(): string | undefined;
  testTimeoutMs(): number;
  language(): { lang: string; t: Translate };
  notifyMain(text: string): void;
  /** Puts the confirmation in the user's queue (kind `confirm`) and returns its id; `onAnswer` runs with "approve" or "reject". */
  askConfirm(q: { text: string; payload: unknown }, onAnswer: (answer: string) => void): string;
  /** A ticket changed status in the background (after the user approved): push the state to the UI. */
  changed?(): void;
}

export type ProposeResult =
  | { status: 'asked'; id: string }
  | { status: 'already_asked'; id: string }
  | { status: 'nothing_to_release' }
  | { status: 'tests_failed'; tail: string }
  | { status: 'refused'; code: 'planbranch_checked_out' | 'git_failed' | 'no_main_branch'; detail?: string };

/** The queue refuses payloads above 100,000 characters: the reports are shortened to fit, never the tickets or the files. */
const PAYLOAD_BUDGET = 90_000;
const MAX_REPORT_CHARS = 20_000;
const MIN_REPORT_CHARS = 800;
const MAX_TICKETS = 20;

interface Pending { id: string; tip: string; slugs: string[] }

/**
 * The release to `origin/main` (SPEC 15.5): the console proposes, the user approves once from the queue, and only then the console
 * merges the plan branch into the local `main` of the user's checkout, runs the tests, and pushes with a one-time token that the
 * pre-push hook asks for. Whatever goes wrong, the checkout keeps what the user changed in the meantime.
 */
export class ReleaseService {
  private pending: Pending | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly d: ReleaseDeps) {}

  /** Resolves when the release being performed (if any) is over. */
  idle(): Promise<void> { return this.inFlight; }

  proposeRelease(): Promise<ProposeResult> {
    // The proposal runs the tests in the console's plan worktree, which a merge is using at times: one at a time.
    return withPlanLock(this.d.root, () => this.propose());
  }

  private async propose(): Promise<ProposeResult> {
    const merged = this.d.tickets.list().filter((t) => t.status === 'merged');
    if (merged.length === 0) return { status: 'nothing_to_release' };
    if (this.pending) return { status: 'already_asked', id: this.pending.id };
    const target = await this.targetBranch();
    if (!target) return { status: 'refused', code: 'no_main_branch' };
    const plan = await ensurePlanWorktree(this.d.root, this.d.plan);
    if (!plan.ok) return { status: 'refused', code: plan.code, detail: plan.detail };
    const tip = (await git(plan.path, ['rev-parse', 'HEAD'])).stdout.trim();

    const command = this.d.testCommand()?.trim();
    let tests: { ok: boolean; command: string; tail: string } | undefined;
    if (command) {
      const run = await runValidation({ cwd: plan.path, command, timeoutMs: this.d.testTimeoutMs() });
      tests = { ok: run.ok, command, tail: run.tail };
      if (!run.ok) return { status: 'tests_failed', tail: run.tail };
    }
    const { files, extraCommits } = await this.whatWouldBePushed(target);
    const slugs = merged.map((t) => t.slug);
    const payload = this.payload({ target, tip, files, extraCommits, tests, shown: merged.slice(0, MAX_TICKETS) });
    const id = this.d.askConfirm(
      { text: `Release plan "${this.d.plan}" (${slugs.length} ticket${slugs.length === 1 ? '' : 's'}) to origin/${target}?`, payload },
      (answer) => this.answered(answer, { id, tip, slugs }),
    );
    this.pending = { id, tip, slugs };
    return { status: 'asked', id };
  }

  /**
   * What the push would publish: the plan branch, and also any commit that is on the local main but not on origin yet (the release
   * pushes the whole branch). Compared with `origin/<main>` when there is one.
   */
  private async whatWouldBePushed(target: string): Promise<{ files: ChangedFile[]; extraCommits: number }> {
    const hasOrigin = (await git(this.d.root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}`])).code === 0;
    const base = hasOrigin ? `origin/${target}` : target;
    const fromPlan = (await changedFiles(this.d.root, base, `plan/${this.d.plan}`)) ?? [];
    const fromMain = hasOrigin ? ((await changedFiles(this.d.root, base, target)) ?? []) : [];
    const byPath = new Map<string, ChangedFile>();
    for (const f of [...fromMain, ...fromPlan]) if (!f.path.startsWith('.console/')) byPath.set(f.path, byPath.get(f.path) ?? f);
    const extra = hasOrigin ? Number((await git(this.d.root, ['rev-list', '--count', `origin/${target}..${target}`])).stdout.trim()) : 0;
    return { files: [...byPath.values()], extraCommits: Number.isFinite(extra) ? extra : 0 };
  }

  private payload(o: { target: string; tip: string; files: ChangedFile[]; extraCommits: number; tests?: { ok: boolean; command: string; tail: string }; shown: Ticket[] }): unknown {
    let limit = MAX_REPORT_CHARS;
    for (;;) {
      const payload = {
        plan: this.d.plan, branch: o.target, tip: o.tip, files: o.files, extraCommits: o.extraCommits, tests: o.tests,
        tickets: o.shown.map((t) => this.ticketSummary(t, limit)),
      };
      if (JSON.stringify(payload).length <= PAYLOAD_BUDGET || limit <= MIN_REPORT_CHARS) return payload;
      limit = Math.max(MIN_REPORT_CHARS, Math.floor(limit / 2));
    }
  }

  private ticketSummary(t: Ticket, reportChars: number): unknown {
    let report = '';
    try { report = readFileSync(reportPath(this.d.root, t.slug), 'utf8').slice(0, reportChars); } catch { /* the report is written at merge time; missing means n/a */ }
    return { slug: t.slug, goal: t.goal, mergedSha: t.mergedSha, verdicts: t.verdicts, tests: t.tests ? { ok: t.tests.ok, command: t.tests.command } : undefined, report };
  }

  private answered(answer: string, p: Pending): void {
    if (answer === 'reject') {
      this.pending = undefined;
      this.d.notifyMain(`The user rejected the release of plan "${this.d.plan}". Nothing was merged or pushed; the tickets stay merged in the plan branch.`);
    } else if (answer === 'approve') {
      this.pending = undefined;
      this.inFlight = this.inFlight.then(() => this.perform(p)).catch(() => undefined).finally(() => this.d.changed?.());
    }
  }

  private async targetBranch(): Promise<string | undefined> {
    for (const name of ['main', 'master']) if ((await git(this.d.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).code === 0) return name;
    return undefined;
  }

  private refuse(code: string, text: string): void {
    this.d.notifyMain(`Release of plan "${this.d.plan}" refused (${code}): ${text}`);
  }

  /**
   * Puts the checkout back where it was before our merge, keeping whatever the user edited in the meantime (`reset --keep` refuses to
   * overwrite local changes). False when it could not be undone because of such edits.
   */
  private async undo(before: string): Promise<boolean> {
    return (await git(this.d.root, ['reset', '--keep', '-q', before])).code === 0;
  }

  private async perform(p: Pending): Promise<void> {
    const root = this.d.root;
    const target = await this.targetBranch();
    if (!target) return this.refuse('release.noMainBranch', 'the repository has no main or master branch. Nothing was pushed.');
    const head = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (head.stdout.trim() !== target) return this.refuse('release.notOnMain', `the checkout is not on ${target}; switch to it and propose again. Nothing was pushed and the checkout was left as it was.`);
    const dirty = await git(root, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty.stdout.trim() !== '') return this.refuse('release.dirty', 'the checkout has uncommitted changes to tracked files; commit or stash them and propose again. Nothing was pushed and the checkout was left as it was.');
    const tip = (await git(root, ['rev-parse', `refs/heads/plan/${this.d.plan}`])).stdout.trim();
    if (tip !== p.tip) return this.refuse('release.planMoved', 'the plan branch moved after the proposal, so what you approved is not what would be released; propose again. Nothing was pushed and the checkout was left as it was.');

    const before = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const upToDate = (await git(root, ['merge-base', '--is-ancestor', p.tip, 'HEAD'])).code === 0;
    if (!upToDate) {
      // The approved commit itself, not whatever the branch name points to by the time the merge runs.
      const fastForward = (await git(root, ['merge-base', '--is-ancestor', 'HEAD', p.tip])).code === 0;
      const merged = fastForward
        ? await git(root, ['merge', '--ff-only', '-q', p.tip])
        : await git(root, [...(await identityArgs(root)), 'merge', '--no-ff', '--no-edit', '-q', '-m', `Release plan ${this.d.plan}`, p.tip]);
      if (merged.code !== 0) {
        await git(root, ['merge', '--abort']);
        const undone = await this.undo(before);
        return this.refuse('release.conflict', `the plan branch does not merge cleanly into ${target}.${undone ? ' Nothing was pushed and the checkout was left as it was.' : ` Your own edits made it impossible to undo completely: check ${target}.`}`);
      }
      const command = this.d.testCommand()?.trim();
      if (command) {
        const run = await runValidation({ cwd: root, command, timeoutMs: this.d.testTimeoutMs() });
        if (!run.ok) {
          const undone = await this.undo(before);
          return this.refuse('release.testsFailed', `the tests fail on ${target} after merging the plan branch. Output:\n${run.tail.trim().slice(-800)}\n${undone ? `The merge was undone: ${target} is back where it was. Nothing was pushed.` : `The merge could NOT be undone because tracked files were edited while the tests ran (your edits were kept): ${target} contains the merge, but nothing was pushed.`}`);
        }
      }
    }

    const remotes = (await git(root, ['remote'])).stdout.split(/\r?\n/).map((l) => l.trim());
    let note = '';
    if (!remotes.includes('origin')) {
      note = ' There is no remote named origin: the release is a local merge only.';
    } else {
      const pushed = await withReleaseToken(root, (env) => git(root, ['push', 'origin', target], { env, timeoutMs: 120_000 }));
      if (pushed.code !== 0) {
        return this.refuse('release.pushFailed', `the merge into ${target} is done locally but the push failed: ${(pushed.stderr || pushed.stdout).trim().slice(-400)} Propose again to retry the push.`);
      }
    }
    for (const slug of p.slugs) {
      const t = this.d.tickets.get(slug);
      if (t?.status === 'merged') this.d.tickets.move(slug, 'released');
    }
    this.d.notifyMain(`Plan "${this.d.plan}" released: ${p.slugs.length} ticket(s) merged into ${target}${note ? '' : ' and pushed to origin'}.${note}`);
  }
}
