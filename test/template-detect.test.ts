import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { detectProject } from '../src/server/templates/detect';
import { autoClose, bootServer, req, ui } from './helpers';

autoClose();
const tmp = (): string => mkdtempSync(join(tmpdir(), 'tpl-detect-'));
const put = (dir: string, name: string, text: string): void => writeFileSync(join(dir, name), text);

it('pom.xml: the project wrapper when there is one, else mvn from the PATH', () => {
  const plain = tmp();
  put(plain, 'pom.xml', '<project/>');
  expect(detectProject(plain, 'win32')).toEqual({ source: 'pom.xml', build: 'mvn -q -DskipTests package', test: 'mvn test' });
  const win = tmp();
  put(win, 'pom.xml', '<project/>');
  put(win, 'mvnw.cmd', '');
  expect(detectProject(win, 'win32')).toMatchObject({ build: 'mvnw.cmd -q -DskipTests package', test: 'mvnw.cmd test' });
  const posix = tmp();
  put(posix, 'pom.xml', '<project/>');
  put(posix, 'mvnw', '');
  expect(detectProject(posix, 'linux')).toMatchObject({ build: './mvnw -q -DskipTests package', test: './mvnw test' });
  expect(detectProject(win, 'linux')).toMatchObject({ test: 'mvn test' }); // a .cmd wrapper means nothing on linux
});

it('Gradle (groovy or kotlin script), with or without the wrapper', () => {
  const g = tmp();
  put(g, 'build.gradle', '');
  expect(detectProject(g, 'linux')).toEqual({ source: 'gradle', build: 'gradle build -x test', test: 'gradle test' });
  const k = tmp();
  put(k, 'build.gradle.kts', '');
  put(k, 'gradlew.bat', '');
  expect(detectProject(k, 'win32')).toMatchObject({ source: 'gradle', build: 'gradlew.bat build -x test', test: 'gradlew.bat test' });
});

it('package.json: only the scripts that exist are proposed', () => {
  const all = tmp();
  put(all, 'package.json', JSON.stringify({ scripts: { build: 'x', test: 'y', lint: 'z' } }));
  expect(detectProject(all)).toEqual({ source: 'package.json', build: 'npm run build', test: 'npm test', lint: 'npm run lint' });
  const some = tmp();
  put(some, 'package.json', JSON.stringify({ scripts: { test: 'y' } }));
  expect(detectProject(some)).toEqual({ source: 'package.json', test: 'npm test' });
});

it('nothing found gives an empty object: an empty folder, no scripts, broken or oversized package.json', () => {
  expect(detectProject(tmp())).toEqual({});
  const noScripts = tmp();
  put(noScripts, 'package.json', JSON.stringify({ name: 'x' }));
  expect(detectProject(noScripts)).toEqual({});
  const broken = tmp();
  put(broken, 'package.json', '{nope');
  expect(detectProject(broken)).toEqual({});
  const big = tmp();
  put(big, 'package.json', JSON.stringify({ scripts: { test: 'y' }, pad: 'x'.repeat(300 * 1024) }));
  expect(detectProject(big)).toEqual({}); // never reads more than 256 KiB
});

it('pom.xml wins over package.json (the first known build tool decides)', () => {
  const d = tmp();
  put(d, 'pom.xml', '<project/>');
  put(d, 'package.json', JSON.stringify({ scripts: { test: 'y' } }));
  expect(detectProject(d, 'linux').source).toBe('pom.xml');
});

it('GET /api/projects/detect needs the token and an existing absolute folder', async () => {
  const s = await bootServer();
  const d = tmp();
  put(d, 'package.json', JSON.stringify({ scripts: { test: 'y' } }));
  const url = (root: string): string => `/api/projects/detect?root=${encodeURIComponent(root)}`;
  expect((await ui(s, url(d))).body).toEqual({ source: 'package.json', test: 'npm test' });
  expect((await ui(s, url(tmp()))).body).toEqual({});
  expect((await ui(s, url(join(d, 'missing')))).body).toMatchObject({ code: 'project.badRoot' });
  expect((await ui(s, url('relative/dir'))).status).toBe(422);
  expect((await ui(s, '/api/projects/detect')).status).toBe(422);
  expect((await req(s, url(d))).status).toBe(401);
});
