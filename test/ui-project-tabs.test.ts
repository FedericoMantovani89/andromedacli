// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { neighbourPlan, renderPlanTabs, titleWithWaiting } from '../src/ui/plan-tabs';
import type { PlanTab } from '../src/shared/protocol';

const plan = (name: string, waiting = 0): PlanTab => ({ name, root: `/x/${name}`, waiting, mainStatus: 'running' });
const handlers = () => ({ select: vi.fn(), close: vi.fn(), add: vi.fn() });

describe('plan tabs', () => {
  it('renders one tab per plan, marks the selected one and a dot for a waiting queue', () => {
    const el = document.createElement('nav');
    renderPlanTabs(el, [plan('alpha'), plan('beta', 2)], 'alpha', handlers());
    const tabs = [...el.querySelectorAll<HTMLElement>('button.tab')];
    expect(tabs.slice(0, 2).map((t) => t.textContent)).toEqual(['alpha', 'beta']);
    expect(tabs).toHaveLength(3); // the two plans and the new-plan button
    expect(tabs[0]!.classList.contains('current')).toBe(true);
    expect(tabs[0]!.classList.contains('attention')).toBe(false);
    expect(tabs[1]!.classList.contains('attention')).toBe(true);
    expect(el.querySelectorAll('.tab-close').length).toBe(2);
  });

  it('calls the handlers for select, close and add', () => {
    const el = document.createElement('nav');
    const h = handlers();
    renderPlanTabs(el, [plan('alpha'), plan('beta')], 'alpha', h);
    el.querySelectorAll<HTMLElement>('button.tab')[1]!.click();
    el.querySelectorAll<HTMLElement>('.tab-close')[0]!.click();
    [...el.querySelectorAll<HTMLElement>('button.tab')].pop()!.click();
    expect(h.select).toHaveBeenCalledWith('beta');
    expect(h.close).toHaveBeenCalledWith('alpha');
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  it('puts the total of waiting questions in the title only when above zero', () => {
    expect(titleWithWaiting('Console', [plan('a'), plan('b')])).toBe('Console');
    expect(titleWithWaiting('Console', [plan('a', 1), plan('b', 2)])).toBe('(3) Console');
  });

  it('finds the neighbour plan and wraps around', () => {
    const plans = [plan('a'), plan('b'), plan('c')];
    expect(neighbourPlan(plans, 'a', 1)).toBe('b');
    expect(neighbourPlan(plans, 'a', -1)).toBe('c');
    expect(neighbourPlan(plans, 'c', 1)).toBe('a');
    expect(neighbourPlan([plan('a')], 'a', 1)).toBeUndefined();
  });
});
