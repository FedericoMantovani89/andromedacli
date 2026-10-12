import { it, expect } from 'vitest';
import { computeAgentLayout } from '../src/shared/layout';

const names = (n: number) => Array.from({ length: n }, (_, i) => `job-${i + 1}`);
it('shows up to 4 agents as panels', () => {
  expect(computeAgentLayout(names(4), null).every((x) => x.mode === 'panel')).toBe(true);
});
it('collapses agents beyond 4 into bars', () => {
  const l = computeAgentLayout(names(6), null);
  expect(l.filter((x) => x.mode === 'panel').map((x) => x.slug)).toEqual(['job-1', 'job-2', 'job-3', 'job-4']);
  expect(l.filter((x) => x.mode === 'bar').map((x) => x.slug)).toEqual(['job-5', 'job-6']);
});
it('expanding a bar keeps exactly 4 panels by demoting the last panel', () => {
  const l = computeAgentLayout(names(6), 'job-6');
  expect(l.filter((x) => x.mode === 'panel').map((x) => x.slug).sort()).toEqual(['job-1', 'job-2', 'job-3', 'job-6']);
  expect(l.map((x) => x.slug)).toEqual(names(6));
});
it('ignores an expanded slug that is already a panel or unknown', () => {
  expect(computeAgentLayout(names(5), 'job-2').filter((x) => x.mode === 'panel').map((x) => x.slug)).toEqual(['job-1', 'job-2', 'job-3', 'job-4']);
  expect(computeAgentLayout(names(5), 'ghost').filter((x) => x.mode === 'bar').map((x) => x.slug)).toEqual(['job-5']);
});
it('a compacted agent becomes a bar and leaves its slot to the next one', () => {
  const l = computeAgentLayout(names(5), null, 4, new Set(['job-2']));
  expect(l.filter((x) => x.mode === 'bar').map((x) => x.slug)).toEqual(['job-2']);
  expect(l.filter((x) => x.mode === 'panel')).toHaveLength(4);
});
it('expanding a compacted bar uses a free slot, and demotes the last panel only when none is free', () => {
  expect(computeAgentLayout(names(3), 'job-2', 4, new Set(['job-2'])).every((x) => x.mode === 'panel')).toBe(true);
  const full = computeAgentLayout(names(5), 'job-2', 4, new Set(['job-2']));
  expect(full.filter((x) => x.mode === 'panel')).toHaveLength(4);
  expect(full.find((x) => x.slug === 'job-2')!.mode).toBe('panel');
});
it('handles zero agents', () => expect(computeAgentLayout([], null)).toEqual([]));
