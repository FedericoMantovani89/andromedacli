import type { ApiError } from '../shared/protocol';
import { api } from './api';
import { bindText, t } from './i18n-client';
import { focusElementFromUser } from './focus';

/** Translates a server error code (SPEC 5.9: the server sends codes and parameters, never sentences). */
export function errorText(err: ApiError): string {
  const text = t('error.' + err.code, err.params);
  return text === `error.${err.code}` ? t('error.generic') : text;
}

/**
 * The "+ new agent" control. Opening the form is a user click, so moving the cursor into the slug field is allowed;
 * creating an agent never moves the keyboard anywhere (the new panel appears dimmed, P2).
 */
export function createNewAgentControl(getProfiles: () => readonly string[], afterCreate: () => void, getRepos: () => readonly string[] = () => []): HTMLElement {
  const wrap = document.createElement('div');
  const button = document.createElement('button');
  button.id = 'new-agent-btn';
  bindText(button, 'panel.newAgent');
  wrap.append(button);

  button.addEventListener('click', () => {
    const form = document.createElement('form');
    form.className = 'new-agent-form';

    const slugLabel = document.createElement('label');
    const slugText = document.createElement('span');
    bindText(slugText, 'panel.slugLabel');
    const slug = document.createElement('input');
    slug.name = 'slug';
    slug.autocomplete = 'off';
    slugLabel.append(slugText, slug);

    const profileLabel = document.createElement('label');
    const profileText = document.createElement('span');
    bindText(profileText, 'panel.profileLabel');
    const profile = document.createElement('select');
    profile.name = 'profile';
    for (const p of getProfiles()) {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p; // profile names are data
      profile.append(o);
    }
    profileLabel.append(profileText, profile);

    // A project folder that holds several repositories: the agent works in exactly one of them.
    const repoNames = getRepos().filter((r) => r !== '');
    const repoLabel = document.createElement('label');
    const repo = document.createElement('select');
    repo.name = 'repo';
    if (repoNames.length > 1) {
      const repoText = document.createElement('span');
      bindText(repoText, 'panel.repoLabel');
      for (const r of repoNames) {
        const o = document.createElement('option');
        o.value = r;
        o.textContent = r; // repo names are data
        repo.append(o);
      }
      repoLabel.append(repoText, repo);
    }

    const error = document.createElement('div');
    error.className = 'form-error';
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const create = document.createElement('button');
    create.type = 'submit';
    bindText(create, 'common.create');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    bindText(cancel, 'common.cancel');
    actions.append(create, cancel);
    form.append(slugLabel, profileLabel, repoLabel, error, actions);

    const close = () => { form.remove(); button.hidden = false; afterCreate(); };
    cancel.addEventListener('click', close);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void api<ApiError | { slug: string }>('/api/agents', { method: 'POST', body: { slug: slug.value, profile: profile.value, ...(repoNames.length > 1 ? { repo: repo.value } : {}) } })
        .then((res) => {
          if (res.status === 201 || res.status === 202) close(); // 202: queued behind the limit, it starts by itself
          else error.textContent = errorText(res.body as ApiError);
        });
    });

    button.hidden = true;
    wrap.append(form);
    focusElementFromUser(slug, 'user');
  });
  return wrap;
}
