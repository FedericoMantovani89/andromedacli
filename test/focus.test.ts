import { it, expect } from 'vitest';
import { FocusState } from '../src/ui/focus';

it('starts on the main panel', () => expect(new FocusState('shop-api').active).toBe('shop-api'));
it('a new panel never takes the focus', () => {
  const f = new FocusState('shop-api');
  f.onPanelAdded('fix-login'); f.onPanelAdded('ui-cart');
  expect(f.active).toBe('shop-api');
});
it('only an explicit activation moves the focus', () => {
  const f = new FocusState('shop-api'); f.onPanelAdded('fix-login');
  f.activate('fix-login');
  expect(f.active).toBe('fix-login');
});
it('removing the active panel returns the focus to main, never to a neighbour', () => {
  const f = new FocusState('shop-api'); f.onPanelAdded('a-job'); f.onPanelAdded('b-job');
  f.activate('a-job'); f.remove('a-job');
  expect(f.active).toBe('shop-api');
});
it('ignores activation of an unknown panel', () => {
  const f = new FocusState('shop-api'); f.activate('ghost');
  expect(f.active).toBe('shop-api');
});
it('main can never be removed', () => {
  const f = new FocusState('shop-api'); f.remove('shop-api');
  expect(f.active).toBe('shop-api');
  f.onPanelAdded('x-job'); f.activate('shop-api');
  expect(f.active).toBe('shop-api');
});
