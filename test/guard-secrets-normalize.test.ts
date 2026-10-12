import { describe, expect, it } from 'vitest';
import { normalizeSecretPath } from '../src/server/guard/rules';
import { fileVerdict, verdict, type Row } from './guard-table';

describe('normalizeSecretPath', () => {
  it('drops data streams, trailing dots and spaces, and quotes', () => {
    expect(normalizeSecretPath('.env::$DATA')).toBe('.env');
    expect(normalizeSecretPath('C:\\p\\.env:stream')).toBe('C:\\p\\.env');
    expect(normalizeSecretPath('.env.')).toBe('.env');
    expect(normalizeSecretPath('".env "')).toBe('.env');
    expect(normalizeSecretPath('src/a.ts')).toBe('src/a.ts');
    expect(normalizeSecretPath('..')).toBe('..');
    expect(normalizeSecretPath('C:\\p\\a.txt')).toBe('C:\\p\\a.txt');
  });
});

describe('secrets read through other spellings and tools', () => {
  const bash: Row[] = [
    ['cat .env::$DATA', 'secret.file'],
    ['cat .env.', 'secret.file'],
    ['findstr . .env', 'secret.file'],
    ['findstr /i token .env', 'secret.file'],
    ['git show HEAD:.env', 'secret.file'],
    ['git show HEAD~1:config/.env', 'secret.file'],
    ['cat .env', 'secret.file'],
    ['cat .env.example', 'ALLOW'],
    ['git show HEAD:src/a.ts', 'ALLOW'],
    ['findstr /i foo src\\a.ts', 'ALLOW'],
    ['cat README.md', 'ALLOW'],
  ];
  it.each(bash)('bash: %s -> %s', (c, e) => expect(verdict(c)).toBe(e));

  it('powershell: a trailing space', () => {
    expect(verdict('Get-Content ".env "', { tool: 'PowerShell' })).toBe('secret.file');
  });
  it('the file tools use the same normalization', () => {
    expect(fileVerdict('Read', '.env::$DATA')).toBe('secret.file');
    expect(fileVerdict('Read', 'src/a.ts')).toBe('ALLOW');
  });
});
