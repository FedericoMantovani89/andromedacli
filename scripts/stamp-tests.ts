// Called by `npm test`: `begin` before the full suite, `done` after it passed. The stamp is what scripts/commit-gate.ts looks for.
import { stamp } from './commit-gate.ts';

const step = process.argv[2];
if (step !== 'begin' && step !== 'done') { console.error('usage: stamp-tests.ts begin|done'); process.exit(1); }
stamp(process.cwd(), step);
