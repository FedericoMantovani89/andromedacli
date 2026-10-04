import { it, expect } from 'vitest';
import { findSecrets, DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';

const find = (files: string[], patterns = DEFAULT_SECRET_PATTERNS) => findSecrets(files, patterns);

it('catches the usual secret files at any depth', () => {
  expect(find(['.env', '.env.local', 'a/b/.env', 'config/.env.production', 'certs/server.pem', 'keys/app.key', 'id_rsa', 'home/.ssh/id_ed25519', 'credentials.json', 'aws/credentials', 'store.p12', 'x.pfx', 'app.jks', 'my.keystore']))
    .toEqual(['.env', '.env.local', 'a/b/.env', 'config/.env.production', 'certs/server.pem', 'keys/app.key', 'id_rsa', 'home/.ssh/id_ed25519', 'credentials.json', 'aws/credentials', 'store.p12', 'x.pfx', 'app.jks', 'my.keystore']);
});
it('does not flag look-alikes', () => {
  expect(find(['environment.md', 'my.envelope', 'id_rsa.pub', 'keys.md', 'src/env.ts', 'docs/credentials-guide.md', 'monkey.ts', 'README.md'])).toEqual([]);
});
it('is case-insensitive and understands Windows separators', () => {
  expect(find(['CONFIG\\.ENV', 'Certs\\SERVER.PEM'])).toEqual(['CONFIG\\.ENV', 'Certs\\SERVER.PEM']);
});
it('honours custom patterns, including a directory pattern', () => {
  expect(findSecrets(['secrets/a.txt', 'src/b.txt', 'x.token'], ['secrets/*', '*.token'])).toEqual(['secrets/a.txt', 'x.token']);
});
it('an empty pattern list flags nothing', () => {
  expect(findSecrets(['.env'], [])).toEqual([]);
});
