/** Where a newer version stands (SPEC 33.4). Absent from the state when there is none, or when the app cannot check (development, offline). */
export interface UpdateState {
  /** `available`: found, nothing downloaded yet. `downloading`: `percent` says how far. `ready`: downloaded, waits for a restart. */
  phase: 'available' | 'downloading' | 'ready';
  version: string;
  percent?: number;
}

/** What the desktop app gives the server so the page can offer an update; the server only relays (state, two actions, a change signal). */
export interface UpdateControl {
  state(): UpdateState | undefined;
  /** The user chose to download: nothing is ever downloaded on its own. */
  download(): void;
  /** The user chose to restart into the new version (the app asks first when agents are running). */
  install(): void | Promise<void>;
  /** The server pushes the state to the page whenever this calls back. */
  onChange(cb: () => void): void;
}
