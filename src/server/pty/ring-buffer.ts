const ESC = String.fromCharCode(27);
const MODE_RE = new RegExp(`${ESC}\\[\\?([0-9;]+)([hl])`, 'g');
const CARRY = 16; // longest mode sequence we look for, so one split across two chunks is still seen

/**
 * Keeps the last `capacity` bytes of a terminal.
 * - Appends are O(chunk): chunks are kept in a list and the oldest are dropped, never copied.
 * - A replay starts at a line boundary, so an escape sequence is never cut in half.
 * - DEC private modes (bracketed paste, cursor visibility, focus reporting...) are tracked as they stream past, and a
 *   replay starts by restoring them, because the sequence that set them may already have left the window.
 */
export class ByteRing {
  private chunks: Buffer[] = [];
  private size = 0;
  private wrapped = false;
  private readonly modes = new Map<number, boolean>();
  private carry = '';

  constructor(private readonly capacity: number) {}

  append(chunk: Buffer): void {
    this.trackModes(chunk);
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.capacity) {
      this.size -= this.chunks.shift()!.length;
      this.wrapped = true;
    }
    if (this.size > this.capacity) {
      const excess = this.size - this.capacity;
      this.chunks[0] = this.chunks[0]!.subarray(excess);
      this.size = this.capacity;
      this.wrapped = true;
    }
  }

  snapshot(): Buffer {
    const all = Buffer.concat(this.chunks);
    if (!this.wrapped) return all;
    const nl = all.indexOf(0x0a);
    const body = nl === -1 ? Buffer.alloc(0) : all.subarray(nl + 1);
    return Buffer.concat([this.modePrefix(), body]);
  }

  private trackModes(chunk: Buffer): void {
    const text = this.carry + chunk.toString('latin1');
    for (const m of text.matchAll(MODE_RE)) {
      for (const n of m[1]!.split(';')) this.modes.set(Number(n), m[2] === 'h');
    }
    this.carry = text.slice(-CARRY);
  }

  private modePrefix(): Buffer {
    let out = '';
    for (const [mode, on] of this.modes) out += `${ESC}[?${mode}${on ? 'h' : 'l'}`;
    return Buffer.from(out, 'latin1');
  }
}
