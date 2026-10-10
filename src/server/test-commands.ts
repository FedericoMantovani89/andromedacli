import type { ProjectInfo, TestMoment } from './project-store';

/**
 * The test command the console runs at one moment: the project's command for that moment, else its single `testCommand`, else the one
 * detected from the project's files. With the tests inhibited there is none (every moment then runs nothing and the reports say "not run").
 */
export function testCommandFor(
  moment: TestMoment,
  d: { project(): Pick<ProjectInfo, 'testCommand' | 'testCommands' | 'testsDisabled'>; detected(): string | undefined },
): string | undefined {
  let p: ReturnType<typeof d.project> = {};
  try { p = d.project(); } catch { /* a damaged project.json: as a project with no settings */ }
  if (p.testsDisabled === true) return undefined;
  return p.testCommands?.[moment]?.trim() || p.testCommand?.trim() || d.detected();
}
