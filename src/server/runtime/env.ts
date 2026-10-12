import type { StartOptions } from '../index';
import type { Shared } from './types';

/** What the console hands to a project: the shared parts and the options bound to this project's folder. */
export interface Env {
  shared: Shared;
  o: StartOptions & { projectRoot: string; projectName: string };
  configPath: Shared['configPath'];
  config: Shared['config'];
  token: Shared['token'];
  bundles: Shared['bundles'];
  ledger: Shared['ledger'];
  quotaState: Shared['quotaState'];
  sleep: Shared['sleep'];
  sleepClock: Shared['sleepClock'];
  runtime: Shared['runtime'];
  limits: Shared['limits'];
}
