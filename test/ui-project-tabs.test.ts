// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { neighbourProject, renderProjectTabs, titleWithWaiting } from '../src/ui/project-tabs';
import type { ProjectTab } from '../src/shared/protocol';

const project = (name: string, waiting = 0): ProjectTab => ({ name, root: `/x/${name}`, waiting, mainStatus: 'running' });
const handlers = () => ({ select: vi.fn(), close: vi.fn(), add: vi.fn() });

describe('project tabs', () => {
  it('renders one tab per project, marks the selected one and a dot for a waiting queue', () => {
    const el = document.createElement('nav');
    renderProjectTabs(el, [project('alpha'), project('beta', 2)], 'alpha', handlers());
    const tabs = [...el.querySelectorAll<HTMLElement>('button.tab')];
    expect(tabs.slice(0, 2).map((t) => t.textContent)).toEqual(['alpha', 'beta']);
    expect(tabs).toHaveLength(3); // the two projects and the new-project button
    expect(tabs[0]!.classList.contains('current')).toBe(true);
    expect(tabs[0]!.classList.contains('attention')).toBe(false);
    expect(tabs[1]!.classList.contains('attention')).toBe(true);
    expect(el.querySelectorAll('.tab-close').length).toBe(2);
  });

  it('calls the handlers for select, close and add', () => {
    const el = document.createElement('nav');
    const h = handlers();
    renderProjectTabs(el, [project('alpha'), project('beta')], 'alpha', h);
    el.querySelectorAll<HTMLElement>('button.tab')[1]!.click();
    el.querySelectorAll<HTMLElement>('.tab-close')[0]!.click();
    [...el.querySelectorAll<HTMLElement>('button.tab')].pop()!.click();
    expect(h.select).toHaveBeenCalledWith('beta');
    expect(h.close).toHaveBeenCalledWith('alpha');
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  it('puts the total of waiting questions in the title only when above zero', () => {
    expect(titleWithWaiting('Console', [project('a'), project('b')])).toBe('Console');
    expect(titleWithWaiting('Console', [project('a', 1), project('b', 2)])).toBe('(3) Console');
  });

  it('finds the neighbour project and wraps around', () => {
    const projects = [project('a'), project('b'), project('c')];
    expect(neighbourProject(projects, 'a', 1)).toBe('b');
    expect(neighbourProject(projects, 'a', -1)).toBe('c');
    expect(neighbourProject(projects, 'c', 1)).toBe('a');
    expect(neighbourProject([project('a')], 'a', 1)).toBeUndefined();
  });
});
