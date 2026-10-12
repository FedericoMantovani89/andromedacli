import { expect, it } from 'vitest';
import { boot, Container } from '../src/server/runtime/container';

interface S { a: string; b: number; c: { a: string; b: number }; loop1: number; loop2: number; self: number }
const make = (): Container<S> => new Container<S>();

it('creates a service on first use and gives the same object every time', () => {
  const c = make();
  let made = 0;
  c.provide('a', () => { made++; return 'x'; });
  expect(made).toBe(0);
  expect(c.get('a')).toBe('x');
  expect(c.get('a')).toBe('x');
  expect(made).toBe(1);
});

it('a factory can ask for other services', () => {
  const c = make();
  c.provide('a', () => 'x');
  c.provide('b', (k) => k.get('a').length);
  c.provide('c', (k) => ({ a: k.get('a'), b: k.get('b') }));
  expect(c.get('c')).toEqual({ a: 'x', b: 1 });
});

it('says which key has no provider', () => {
  expect(() => make().get('a')).toThrow('no provider for "a"');
});

it('refuses a second provider for a key, and override replaces it before the first use', () => {
  const c = make();
  c.provide('a', () => 'x');
  expect(() => c.provide('a', () => 'y')).toThrow('already provided: "a"');
  c.override('a', () => 'y');
  expect(c.get('a')).toBe('y');
  expect(() => c.override('a', () => 'z')).toThrow('cannot override "a": it was already created');
});

it('reports a cycle with its chain of keys', () => {
  const c = make();
  c.provide('loop1', (k) => k.get('loop2') + 1);
  c.provide('loop2', (k) => k.get('loop1') + 1);
  expect(() => c.get('loop1')).toThrow('container cycle: loop1 -> loop2 -> loop1');
});

it('reports a service that needs itself', () => {
  const c = make();
  c.provide('self', (k) => k.get('self'));
  expect(() => c.get('self')).toThrow('container cycle: self -> self');
});

it('a circular use inside a lambda is fine: it runs after both exist', () => {
  const c = make();
  c.provide('loop1', (k) => { const later = () => k.get('loop2'); return later() === undefined ? 0 : 1; });
  c.provide('loop2', () => 2);
  expect(c.get('loop1')).toBe(1);
});

it('a failed factory leaves the key free to be asked again, and the chain is clean', () => {
  const c = make();
  let fail = true;
  c.provide('a', () => { if (fail) throw new Error('boom'); return 'ok'; });
  expect(() => c.get('a')).toThrow('boom');
  fail = false;
  expect(c.get('a')).toBe('ok');
});

it('has() tells whether a provider exists, and onCreate sees the creation order', () => {
  const created: string[] = [];
  const c = new Container<S>({ onCreate: (k) => created.push(String(k)) });
  c.provide('a', () => 'x');
  c.provide('b', (k) => k.get('a').length);
  expect(c.has('a')).toBe(true);
  expect(c.has('c')).toBe(false);
  c.get('b');
  expect(created).toEqual(['a', 'b']);
});

it('boot() creates the listed services in that order', () => {
  const created: string[] = [];
  const c = new Container<S>({ onCreate: (k) => created.push(String(k)) });
  c.provide('b', () => 1);
  c.provide('a', () => 'x');
  boot(c, ['a', 'b']);
  expect(created).toEqual(['a', 'b']);
});
