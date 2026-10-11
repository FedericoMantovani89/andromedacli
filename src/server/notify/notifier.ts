import { errorMessage } from '../../shared/guards';
export interface NotifierMessage { title: string; message: string; open?: string; sound: boolean }

export interface Notifier {
  available(): Promise<boolean>;
  /** Never throws: a failure is recorded in `lastError` (cleared by the next success). */
  notify(n: NotifierMessage): Promise<void>;
  readonly lastError?: string;
}

/** Does nothing: tests that do not care, and platforms without a toast. */
export class NullNotifier implements Notifier {
  async available(): Promise<boolean> { return false; }
  async notify(): Promise<void> { /* nothing */ }
}

interface NodeNotifier { notify(o: Record<string, unknown>, cb: (err: Error | null) => void): unknown }

/** Native toast through the `node-notifier` package (it ships SnoreToast for Windows). */
export class ToastNotifier implements Notifier {
  lastError: string | undefined;
  private module: Promise<NodeNotifier | undefined> | undefined;

  private load(): Promise<NodeNotifier | undefined> {
    this.module ??= import('node-notifier').then((m) => (m.default ?? m) as unknown as NodeNotifier).catch((e: unknown) => {
      this.lastError = errorMessage(e);
      return undefined;
    });
    return this.module;
  }

  async available(): Promise<boolean> {
    return (await this.load()) !== undefined;
  }

  async notify(n: NotifierMessage): Promise<void> {
    const mod = await this.load();
    if (!mod) return;
    await new Promise<void>((done) => {
      try {
        mod.notify({ title: n.title, message: n.message, sound: n.sound, wait: true, ...(n.open ? { open: n.open } : {}) }, (err) => {
          this.lastError = err ? err.message : undefined;
          done();
        });
      } catch (e) {
        this.lastError = errorMessage(e);
        done();
      }
    });
  }
}
