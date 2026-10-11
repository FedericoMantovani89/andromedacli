import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_FIELDS, ProjectStore } from '../project-store';
import { PROFILE_FILE_RE } from '../../shared/slug';
import { errorMessage } from '../../shared/guards';


export type CopyResult = { ok: true } | { ok: false; code: string; detail?: string };

/**
 * Copies the settings of one project onto another (SPEC 21): its profiles, main.md and rules.md (files of the same name are replaced) and
 * the fields of project.json (test, build and lint commands, squash, model, token budget, agent limit, profiles on offer, docs, secret
 * patterns). A field the source does not have is cleared in the target, so the two end up alike. The name, the agents and the tickets are
 * never copied. The target's `.andromedacli` is created when missing.
 */
export function copyProjectSettings(fromRoot: string, toRoot: string, toName: string): CopyResult {
  try {
    const from = new ProjectStore(fromRoot);
    const source = from.project;
    const to = new ProjectStore(toRoot);
    to.init(toName);
    const fromDir = join(fromRoot, '.andromedacli');
    const toDir = join(toRoot, '.andromedacli');
    mkdirSync(toDir, { recursive: true });
    for (const f of ['main.md', 'rules.md']) if (existsSync(join(fromDir, f))) copyFileSync(join(fromDir, f), join(toDir, f));
    const profiles = join(fromDir, 'profiles');
    if (existsSync(profiles)) {
      mkdirSync(join(toDir, 'profiles'), { recursive: true });
      for (const f of readdirSync(profiles)) if (PROFILE_FILE_RE.test(f)) copyFileSync(join(profiles, f), join(toDir, 'profiles', f));
    }
    to.setFields(Object.fromEntries(PROJECT_FIELDS.map((f) => [f, (source as unknown as Record<string, unknown>)[f]])));
    to.setTestCommand(source.testCommand ?? '');
    to.setTestCommands({ ticket: source.testCommands?.ticket ?? '', merge: source.testCommands?.merge ?? '', release: source.testCommands?.release ?? '' });
    if (source.squash !== undefined) to.setSquash(source.squash);
    to.setTestsDisabled(source.testsDisabled === true);
    return { ok: true };
  } catch (e) {
    const message = errorMessage(e);
    return { ok: false, code: message.startsWith('project.') ? message.split(':')[0]! : 'project.notFound', detail: message };
  }
}
