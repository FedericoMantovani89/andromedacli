import { expect, it } from 'vitest';
import { CONFIG_RANGES, DEFAULT_CONFIG, validateConfig } from '../src/server/config';

it('the request settings default to 15 minutes and 3 hops', () => {
  expect(DEFAULT_CONFIG.agents.requestTimeoutMinutes).toBe(15);
  expect(DEFAULT_CONFIG.agents.requestMaxHops).toBe(3);
  expect(CONFIG_RANGES['agents.requestTimeoutMinutes']).toEqual([1, 240]);
  expect(CONFIG_RANGES['agents.requestMaxHops']).toEqual([1, 10]);
});
it('accepts values inside the range', () => {
  const { config, errors } = validateConfig({ agents: { requestTimeoutMinutes: 30, requestMaxHops: 5 } });
  expect(errors).toEqual([]);
  expect(config.agents).toMatchObject({ requestTimeoutMinutes: 30, requestMaxHops: 5 });
});
it('keeps the default and reports an entry outside the range or not a whole number', () => {
  const { config, errors } = validateConfig({ agents: { requestTimeoutMinutes: 0, requestMaxHops: 2.5 } });
  expect(errors.map((e) => e.path).sort()).toEqual(['agents.requestMaxHops', 'agents.requestTimeoutMinutes']);
  expect(config.agents.requestTimeoutMinutes).toBe(15);
  expect(config.agents.requestMaxHops).toBe(3);
});
