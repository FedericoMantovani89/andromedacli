// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openNewPlanDialog } = await import('../src/ui/new-plan');
const { showWelcome } = await import('../src/ui/welcome');

interface Call { path: string; method: string; body: unknown }
const calls: Call[] = [];
let pick: { status: number; body: unknown };
let created: { status: number; body: unknown };

beforeEach(() => {
  calls.length = 0;
  pick = { status: 200, body: { status: 'picked', path: 'D:\\work\\Shop API' } };
  created = { status: 201, body: { name: 'shop-api' } };
  document.body.innerHTML = '<header id="topbar"></header><main id="workspace"></main><footer id="statusbar"></footer><div id="drawer" hidden></div><div id="overlay" hidden></div>';
  vi.stubGlobal('fetch', async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = (status: number, body: unknown) => ({ status, json: async () => body });
    if (path === '/api/pick-folder') return answer(pick.status, pick.body);
    if (path === '/api/plans' && method === 'POST') return answer(created.status, created.body);
    if (path.startsWith('/api/plans/detect')) return answer(200, { source: 'pom.xml', build: 'mvn package', test: 'mvn test' });
    if (path === '/api/templates') return answer(200, [{ id: 'generic', name: { en: 'Generic' }, description: { en: '' }, source: 'shipped', valid: true }]);
    return answer(200, []);
  });
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const field = (name: string): HTMLInputElement => document.querySelector(`#overlay input[name="${name}"]`)!;
const browse = (): HTMLButtonElement => document.querySelector('#overlay button.browse-folder')!;

describe('the Browse button of the new-plan dialog', () => {
  it('fills the folder with what the native window returned, proposes the name and reads the project', async () => {
    openNewPlanDialog(() => undefined);
    await tick();
    expect(browse().dataset.i18n).toBe('plans.new.browse');
    browse().click();
    await tick(); await tick();
    expect(calls.some((c) => c.path === '/api/pick-folder' && c.method === 'POST')).toBe(true);
    expect(field('folder').value).toBe('D:\\work\\Shop API');
    expect(field('name').value).toBe('shop-api');
    expect(calls.some((c) => c.path === `/api/plans/detect?root=${encodeURIComponent('D:\\work\\Shop API')}`)).toBe(true);
    expect(field('test').value).toBe('mvn test');
  });

  it('leaves the folder alone when the window was closed', async () => {
    pick = { status: 200, body: { status: 'cancelled' } };
    openNewPlanDialog(() => undefined);
    await tick();
    field('folder').value = 'D:\\typed';
    browse().click();
    await tick(); await tick();
    expect(field('folder').value).toBe('D:\\typed');
    expect(calls.some((c) => c.path.startsWith('/api/plans/detect'))).toBe(false);
  });

  it('says so when the window cannot be opened here, and the typed path still works', async () => {
    pick = { status: 200, body: { status: 'unavailable', reason: 'unsupported_platform' } };
    openNewPlanDialog(() => undefined);
    await tick();
    browse().click();
    await tick(); await tick();
    const note = document.querySelector<HTMLElement>('#overlay .browse-note')!;
    expect(note.dataset.i18n).toBe('folder.unavailable');
    expect(field('folder').value).toBe('');
  });

  it('shows the error of a refused request (a window is already open)', async () => {
    pick = { status: 409, body: { code: 'folder.pickBusy' } };
    openNewPlanDialog(() => undefined);
    await tick();
    browse().click();
    await tick(); await tick();
    expect(document.querySelector('#overlay .form-error')!.textContent).not.toBe('');
  });
});

describe('the new-plan dialog tells who created the plan', () => {
  it('calls onCreated with the plan name, after closing, only on success', async () => {
    const onCreated = vi.fn();
    openNewPlanDialog(() => undefined, onCreated);
    await tick();
    field('folder').value = 'D:\\work\\shop-api';
    document.querySelector<HTMLFormElement>('#overlay form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    expect(onCreated).toHaveBeenCalledWith('shop-api');
    expect(document.getElementById('overlay')!.hidden).toBe(true);

    onCreated.mockClear();
    created = { status: 409, body: { code: 'plan.duplicate' } };
    openNewPlanDialog(() => undefined, onCreated);
    await tick();
    field('folder').value = 'D:\\work\\shop-api';
    document.querySelector<HTMLFormElement>('#overlay form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe('the welcome screen (no plan open)', () => {
  it('hides the plan chrome, asks for a project at once, and reloads the page once a plan exists', async () => {
    const reload = vi.fn();
    showWelcome({ reload });
    await tick();
    expect(document.getElementById('topbar')!.hidden).toBe(true);
    expect(document.getElementById('workspace')!.hidden).toBe(true);
    expect(document.getElementById('statusbar')!.hidden).toBe(true);
    const welcome = document.getElementById('welcome')!;
    expect(welcome.querySelector('h1')!.dataset.i18n).toBe('welcome.title');
    expect(document.getElementById('overlay')!.hidden).toBe(false); // the folder question is already open
    expect(field('folder')).not.toBeNull();

    field('folder').value = 'D:\\work\\shop-api';
    document.querySelector<HTMLFormElement>('#overlay form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps a button to ask again after the dialog was closed', async () => {
    showWelcome({ reload: vi.fn() });
    await tick();
    document.querySelector<HTMLButtonElement>('#overlay .form-actions button[type="button"]')!.click(); // Cancel
    expect(document.getElementById('overlay')!.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('#welcome button.welcome-choose')!.click();
    await tick();
    expect(document.getElementById('overlay')!.hidden).toBe(false);
  });
});
