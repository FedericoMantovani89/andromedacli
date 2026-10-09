import type { ITerminalOptions } from '@xterm/xterm';

/** Lines each agent terminal keeps in the page (SPEC 33.2): the server keeps the full scrollback and replays it on connect. */
export const SCROLLBACK = 10_000;

/** Terminal look shared by every xterm: it matches the console's graphite palette (see styles.css). */
export const TERM_OPTIONS: ITerminalOptions = {
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
  fontSize: 13,
  theme: {
    background: '#090b0e', foreground: '#dde2ea', cursor: '#62adff', cursorAccent: '#090b0e',
    selectionBackground: 'rgba(98, 173, 255, 0.28)',
    black: '#1b2029', red: '#f2645e', green: '#4cc470', yellow: '#e3a63c', blue: '#62adff', magenta: '#c08bf0', cyan: '#4fc9d6', white: '#c9d0db',
    brightBlack: '#5b6577', brightRed: '#ff8a84', brightGreen: '#74dc92', brightYellow: '#f2c066', brightBlue: '#8cc4ff', brightMagenta: '#d6adf8', brightCyan: '#7edce6', brightWhite: '#f2f5fa',
  },
};
