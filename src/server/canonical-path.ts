import { realpathSync } from 'node:fs';

/**
 * The folder as the file system names it: Windows may hand over the 8.3 short form (`C:\Users\FEDERI~1.MAN\...`) while git prints the
 * long one, and comparing the two made merge and release refuse. A folder that does not exist (yet) is returned as given.
 */
export function canonicalFolder(p: string): string {
  try { return realpathSync.native(p); } catch { return p; }
}
