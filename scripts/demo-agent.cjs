// A stand-in for `claude` that prints a short, made-up Claude Code screen for `scripts/shot-readme.ts` (the README screenshots).
// It runs nothing: the text below is staged, and the screenshots are of a demo project, not of a real run.
const slug = process.env.CONSOLE_AGENT || 'unknown';
const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dot = green('●');
const tool = (call, result) => [`${dot} ${bold(call)}`, dim(`  ⎿  ${result}`)];

const SCREENS = {
  'dice-roller': [
    '',
    `${dim('>')} Add a screen to the dice app: a button that rolls one six-sided die`,
    '  and shows the face, with a short roll animation. Split the work.',
    '',
    `${dot} I will split this into four jobs, each in its own worktree and branch:`,
    '',
    `  ${cyan('dice-logic')}   DiceRoller.kt and unit tests for the 1-6 range`,
    `  ${cyan('dice-ui')}      RollScreen.kt: the button, the face, the animation`,
    `  ${cyan('dice-tests')}   an instrumented test of the screen`,
    `  ${cyan('dice-docs')}    a README section for the app`,
    '',
    `${dot} ${bold('dice-docs')} is merged into project/dice-roller.`,
    `  ${bold('dice-tests')} is delivered: the review is running.`,
    `  ${bold('dice-ui')} has a question for you (should the die vibrate?).`,
    '  I will merge the rest as soon as it is answered.',
    '',
    dim('─'.repeat(70)),
    `${dim('>')} `,
  ],
  'dice-logic': [
    ...tool('Write(app/src/main/java/dev/example/dice/DiceRoller.kt)', 'Wrote 24 lines'),
    ...tool('Write(app/src/test/java/dev/example/dice/DiceRollerTest.kt)', 'Wrote 31 lines'),
    ...tool('Bash(./gradlew testDebugUnitTest)', 'BUILD SUCCESSFUL in 41s'),
    `${dot} Step 3 of 5 done: the roll is always between 1 and 6.`,
    dim('  Committing the step...'),
  ],
  'dice-ui': [
    ...tool('Write(app/src/main/java/dev/example/dice/RollScreen.kt)', 'Wrote 58 lines'),
    `${dot} The button, the face and the roll animation are in place.`,
    `${dot} ${bold('ask_user')}: should the die vibrate when it lands?`,
    dim('  Waiting for your answer...'),
  ],
  'dice-tests': [
    ...tool('Write(app/src/androidTest/java/dev/example/dice/RollScreenTest.kt)', 'Wrote 40 lines'),
    ...tool('Bash(./gradlew connectedDebugAndroidTest)', 'BUILD SUCCESSFUL in 1m 52s'),
    `${dot} Delivered: 4 of 4 steps done, the console re-ran the tests.`,
  ],
  'dice-docs': [
    ...tool('Edit(README.md)', 'Added 14 lines'),
    `${dot} Delivered and merged.`,
  ],
};

for (const line of SCREENS[slug] ?? [`READY ${slug}`]) process.stdout.write(`${line}\r\n`);

if (process.stdin.isTTY) process.stdin.setRawMode(true); // no echo: a terminal's own answers (device attributes) must not be printed back
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => { /* the screens are staged: typed input is ignored */ });
