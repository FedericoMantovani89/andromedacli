/** Files that must never be committed by the console (SPEC 9.3). Matched on the base name, or on the whole path when the pattern has a slash. */
export const DEFAULT_SECRET_PATTERNS: string[] = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'credentials.json', 'credentials.yml', 'credentials.yaml', 'credentials.xml', 'credentials.toml',
];

const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/i;
const SPECIALS = /[.+^${}()|[\]\\]/g;

const toRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(SPECIALS, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`, 'i');

/** Returns the files (as given) that match any pattern. */
export function findSecrets(files: string[], patterns: string[]): string[] {
  const compiled = patterns.map((p) => ({ withDir: p.includes('/'), re: toRegExp(p) }));
  return files.filter((file) => {
    const normalized = file.replace(/\\/g, '/');
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (TEMPLATE_SUFFIX.test(base)) return false; // `.env.example` and friends are meant to be committed
    return compiled.some((c) => c.re.test(c.withDir ? normalized : base));
  });
}
