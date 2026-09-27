'use strict';

const $ = (id) => document.getElementById(id);

let state = null;
let dict = {};
let info = { version: '', languages: [], keys: [] };
let profile = null;          // local, editable copy of the active profile
let saveTimer = null;
let currentPage = 'setup';

const OVERLAY_SIZE = { width: 380, height: 560 };

/* ---------------- helpers ---------------- */

function t(key, vars) {
  let text = dict[key] !== undefined ? dict[key] : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2400);
}

function flashSaved() {
  const el = $('savedTag');
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 1400);
}

/* ---------------- translation ---------------- */

function applyDictionary() {
  document.documentElement.lang = state?.language || 'en';

  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }

  const key = state?.settings.panicKey || 'F8';
  $('panicBody').innerHTML = t('setup.panic.body', { key: `<kbd>${esc(key)}</kbd>` });
  $('commandsHint').innerHTML = `${esc(t('commands.hint', { icon: '▶' }))}<br>`
    + `<b>${esc(t('commands.hint.info'))}</b>`;
  $('holdTipBody').innerHTML = t('commands.holdTip.body', {
    example: `<b>${esc(exampleHold())}</b>`,
  });
  $('overlayObs').textContent = t('setup.overlay.obs', OVERLAY_SIZE);
}

function exampleHold() {
  const holdable = (profile?.commands || []).find((c) => c.allowHold && Number(c.maxHold) > 0);
  if (holdable) return `${holdable.id} 2`;
  const repeating = (profile?.commands || []).find((c) => c.allowRepeat);
  if (repeating) return `${repeating.id} 3`;
  return 'forward 2';
}

/* ---------------- pages ---------------- */

function showPage(page) {
  currentPage = page;
  for (const button of document.querySelectorAll('nav button')) {
    button.classList.toggle('on', button.dataset.page === page);
  }
  for (const section of document.querySelectorAll('.page')) {
    section.classList.toggle('on', section.id === `page-${page}`);
  }
  if (page === 'settings') refreshWindows(false);
  if (page === 'look') refreshPreviews();
}

for (const button of document.querySelectorAll('nav button')) {
  button.addEventListener('click', () => showPage(button.dataset.page));
}

/* ---------------- saving ---------------- */

function queueProfileSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    state = await window.api.saveProfile({
      mode: profile.mode,
      voteSeconds: profile.voteSeconds,
      messageRate: profile.messageRate,
      maxQueue: profile.maxQueue,
      userCooldown: profile.userCooldown,
      targetWindow: profile.targetWindow,
      commands: profile.commands,
    });
    flashSaved();
    renderProblems();
  }, 600);
}

async function saveSettings(patch) {
  state = await window.api.saveSettings(patch);
  flashSaved();
  renderAll(false);
}

/* ---------------- key capture ---------------- */

const CODE_MAP = {
  Space: 'space', Enter: 'enter', Tab: 'tab', Backspace: 'backspace', Escape: 'esc',
  ShiftLeft: 'shift', ShiftRight: 'rshift', ControlLeft: 'ctrl', ControlRight: 'rctrl',
  AltLeft: 'alt', AltRight: 'ralt', CapsLock: 'capslock',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  Insert: 'insert', Delete: 'delete',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
  Quote: "'", Backquote: '`', Backslash: '\\', Comma: ',', Period: '.', Slash: '/',
};

// Modifiers are pressed first and released last, so a combination behaves
// the way a pair of hands would do it.
const MODIFIER_KEYS = ['shift', 'rshift', 'ctrl', 'rctrl', 'alt', 'ralt'];

function orderKeys(keys) {
  return [
    ...keys.filter((k) => MODIFIER_KEYS.includes(k)),
    ...keys.filter((k) => !MODIFIER_KEYS.includes(k)),
  ];
}

function codeToKey(code) {
  if (CODE_MAP[code]) return CODE_MAP[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  return null;
}

/* ---------------- commands ---------------- */

function commandType(command) {
  if (command.type) return command.type;
  if (command.move) return 'move';
  if (command.button || command.mouse) return 'mouse';
  return 'key';
}

const ICONS = {
  eyeOpen: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2C4.2 3.2 1.5 7.4 1.5 8s2.7 4.8 6.5 4.8S14.5 8.6 14.5 8 11.8 3.2 8 3.2z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/></svg>',
  eyeShut: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2C4.2 3.2 1.5 7.4 1.5 8s2.7 4.8 6.5 4.8S14.5 8.6 14.5 8 11.8 3.2 8 3.2z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.2 12.8 12.8 3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  shield: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 13 3.6v4.2c0 3.2-2.1 5.3-5 6.4-2.9-1.1-5-3.2-5-6.4V3.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  override: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 1.6 3.4 9h3.3l-.9 5.4L12.6 7H9.3z" fill="currentColor"/></svg>',
  repeat: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 6.6a4.8 4.8 0 0 1 8.2-1.9M12.6 9.4a4.8 4.8 0 0 1-8.2 1.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M11.9 2.2v2.7H9.2M4.1 13.8v-2.7h2.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  hold: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8.6" r="5.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 5.6v3.2l2.1 1.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

function chip(index, act, on, icon, label, title) {
  return `<button class="chip-toggle${on ? ' on' : ''}" data-act="${act}" data-index="${index}"
            title="${esc(title)}">${icon}<span>${esc(label)}</span></button>`;
}

function renderCommands() {
  const list = $('cmdList');
  const commands = profile?.commands || [];

  if (commands.length === 0) {
    list.innerHTML = `<div class="empty">${esc(t('commands.empty'))}</div>`;
    return;
  }

  list.innerHTML = commands.map((command, index) => {
    const type = commandType(command);
    const keys = (command.keys || []).join(' + ');
    let valueCell;

    if (type === 'key') {
      valueCell = `<button class="keycap" data-act="capture" data-index="${index}">`
        + `${esc(keys || t('commands.key.prompt'))}</button>`;
    } else if (type === 'mouse') {
      valueCell = `<select data-act="button" data-index="${index}">`
        + ['left', 'right', 'middle'].map((b) => `<option value="${b}"`
          + `${command.button === b ? ' selected' : ''}>${esc(t(`commands.mouse.${b}`))}</option>`).join('')
        + '</select>';
    } else {
      const move = command.move || [0, 0];
      valueCell = `<div class="xy">
        <input class="inp" type="number" data-act="mx" data-index="${index}" value="${Number(move[0]) || 0}">
        <input class="inp" type="number" data-act="my" data-index="${index}" value="${Number(move[1]) || 0}">
      </div>`;
    }

    const holdOn = Boolean(command.allowHold);
    const repeatOn = Boolean(command.allowRepeat);
    const holdCap = holdOn
      ? `<input class="inp hold-cap" type="number" step="0.5" min="0.5" data-act="maxHold"
                data-index="${index}" value="${Number(command.maxHold) || 3}"
                title="${esc(t('commands.holdMax.title'))}">`
      : '';
    const repeatFields = repeatOn
      ? `<input class="inp hold-cap" type="number" step="1" min="2" max="50" data-act="repeatCount"
                data-index="${index}" value="${Number(command.repeatCount) || 5}"
                title="${esc(t('commands.repeatCount.title'))}">
         <input class="inp hold-cap" type="number" step="0.05" min="0.05" max="5"
                data-act="repeatInterval" data-index="${index}"
                value="${Number(command.repeatInterval) || 0.25}"
                title="${esc(t('commands.repeatInterval.title'))}">`
      : '';

    return `<div class="cmd-row">
      <div class="cmd-main">
        <input class="inp" data-act="id" data-index="${index}" value="${esc(command.id)}" spellcheck="false">
        <input class="inp" data-act="aliases" data-index="${index}"
               value="${esc((command.aliases || []).join(', '))}"
               placeholder="${esc(t('commands.aliases.placeholder'))}" spellcheck="false">
        <select data-act="type" data-index="${index}">
          <option value="key"${type === 'key' ? ' selected' : ''}>${esc(t('commands.type.key'))}</option>
          <option value="mouse"${type === 'mouse' ? ' selected' : ''}>${esc(t('commands.type.mouse'))}</option>
          <option value="move"${type === 'move' ? ' selected' : ''}>${esc(t('commands.type.move'))}</option>
        </select>
        ${valueCell}
        <input class="inp" type="number" step="0.05" min="0" data-act="length" data-index="${index}"
               value="${command.duration !== undefined ? Number(command.duration) : 0.15}"
               title="${esc(t('commands.length.title'))}">
        <div class="row-tools">
          <button class="icon-btn test" data-act="test" data-index="${index}"
                  title="${esc(t('button.test'))}">&#9654;</button>
          <button class="icon-btn del" data-act="delete" data-index="${index}"
                  title="${esc(t('button.delete'))}">&#10005;</button>
        </div>
      </div>
      <div class="cmd-info">
        <span class="tag">${esc(t('commands.viewersSee'))}</span>
        <input data-act="info" data-index="${index}" value="${esc(command.info || '')}"
               placeholder="${esc(t('commands.viewersSee.placeholder'))}" spellcheck="false">
        <div class="chips">
          ${chip(index, 'hidden', !command.hidden,
    command.hidden ? ICONS.eyeShut : ICONS.eyeOpen,
    t(command.hidden ? 'commands.chip.hidden' : 'commands.chip.shown'),
    t('commands.hidden.title'))}
          ${chip(index, 'modOnly', Boolean(command.modOnly), ICONS.shield,
    t('commands.chip.mods'), t('commands.modOnly.title'))}
          ${chip(index, 'override', Boolean(command.override), ICONS.override,
    t('commands.chip.override'), t('commands.override.title'))}
          ${chip(index, 'allowHold', holdOn, ICONS.hold,
    t('commands.chip.hold'), t('commands.hold.title'))}
          ${holdCap}
          ${chip(index, 'allowRepeat', repeatOn, ICONS.repeat,
    t('commands.chip.repeat'), t('commands.repeat.title'))}
          ${repeatFields}
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderProblems() {
  const bar = $('commandProblems');
  const problems = state?.problems || [];
  if (problems.length === 0) {
    bar.classList.add('hidden');
    return;
  }
  const lines = problems.map(({ id, problem }) => {
    const [kind, detail] = problem.split(':');
    const text = t(`commands.problem.${kind}`, { key: detail, word: detail });
    return `<b>${esc(id)}</b> — ${esc(text)}`;
  });
  bar.innerHTML = lines.join('<br>');
  bar.classList.remove('hidden');
}

let capture = null;

function cancelCapture() {
  if (!capture) return;
  const ending = capture;
  capture = null;
  ending.cleanup();
}

$('cmdList').addEventListener('click', async (event) => {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const index = Number(target.dataset.index);
  const command = profile.commands[index];
  if (!command) return;

  // The four switches under each command are buttons rather than checkboxes,
  // so they toggle here.
  const TOGGLES = ['hidden', 'modOnly', 'override', 'allowHold', 'allowRepeat'];
  const field = TOGGLES.includes(target.dataset.act) ? target.dataset.act : null;
  if (field) {
    command[field] = !command[field];

    // Holding and repeating answer the same question, so turning one on
    // turns the other off rather than leaving both looking active.
    if (field === 'allowHold' && command.allowHold) {
      command.allowRepeat = false;
      if (!(Number(command.maxHold) > 0)) command.maxHold = 3;
    }
    if (field === 'allowRepeat' && command.allowRepeat) {
      command.allowHold = false;
      delete command.maxHold;
      if (!(Number(command.repeatCount) > 1)) command.repeatCount = 5;
      if (!(Number(command.repeatInterval) > 0)) command.repeatInterval = 0.25;
    }
    if (field === 'allowHold' && !command.allowHold) delete command.maxHold;

    renderCommands();
    queueProfileSave();
    return;
  }

  if (target.dataset.act === 'delete') {
    profile.commands.splice(index, 1);
    renderCommands();
    queueProfileSave();
    return;
  }

  if (target.dataset.act === 'test') {
    await window.api.testCommand(command.id);
    toast(t('commands.tested', { name: command.id }));
    return;
  }

  if (target.dataset.act === 'capture') {
    cancelCapture();
    target.dataset.previous = target.textContent;
    target.classList.add('listening');
    target.textContent = t('commands.key.listening');

    // Records a whole chord, not just one key: everything pressed before the
    // last finger comes off counts, so space+a becomes one command.
    const chosen = [];
    const stillDown = new Set();

    const finish = (keep) => {
      cancelCapture();
      if (!keep || chosen.length === 0) {
        target.textContent = target.dataset.previous;
        if (keep) toast(t('commands.key.unusable'));
        return;
      }
      command.type = 'key';
      command.keys = orderKeys(chosen);
      delete command.button;
      delete command.move;
      renderCommands();
      queueProfileSave();
    };

    const onKeyDown = (keyEvent) => {
      keyEvent.preventDefault();
      stillDown.add(keyEvent.code);
      const key = codeToKey(keyEvent.code);
      if (key && !chosen.includes(key) && chosen.length < 4) chosen.push(key);
      if (chosen.length) target.textContent = orderKeys(chosen).join(' + ');
    };

    const onKeyUp = (keyEvent) => {
      keyEvent.preventDefault();
      stillDown.delete(keyEvent.code);
      if (stillDown.size === 0) finish(true);
    };

    // Clicking the box and then wandering off should not leave the app
    // swallowing every key press for the rest of the session.
    const giveUp = setTimeout(() => finish(false), 8000);
    capture = {
      cleanup: () => {
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
        clearTimeout(giveUp);
        target.classList.remove('listening');
      },
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
  }
});

$('cmdList').addEventListener('change', (event) => {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const index = Number(target.dataset.index);
  const command = profile.commands[index];
  if (!command) return;
  const act = target.dataset.act;

  if (act === 'id') {
    const next = target.value.trim().toLowerCase();
    if (!next) {
      target.value = command.id;
      return;
    }
    const clash = profile.commands.some((c, i) => i !== index && c.id === next);
    if (clash) {
      target.value = command.id;
      toast(t('commands.duplicateName'));
      return;
    }
    command.id = next;
  }

  if (act === 'aliases') {
    command.aliases = target.value.split(',')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
  }

  if (act === 'type') {
    command.type = target.value;
    delete command.keys;
    delete command.button;
    delete command.move;
    if (target.value === 'key') command.keys = ['space'];
    else if (target.value === 'mouse') command.button = 'left';
    else command.move = [200, 0];
    renderCommands();
  }

  if (act === 'button') command.button = target.value;

  if (act === 'mx' || act === 'my') {
    const move = command.move || [0, 0];
    command.move = act === 'mx'
      ? [Number(target.value) || 0, move[1]]
      : [move[0], Number(target.value) || 0];
  }

  if (act === 'length') {
    command.duration = Math.max(0, Number(target.value) || 0);
  }

  if (act === 'maxHold') {
    command.maxHold = Math.max(0.5, Number(target.value) || 3);
  }

  if (act === 'repeatCount') {
    command.repeatCount = Math.max(2, Math.min(50, Math.round(Number(target.value) || 5)));
    renderCommands();
  }

  if (act === 'repeatInterval') {
    command.repeatInterval = Math.max(0.05, Math.min(5, Number(target.value) || 0.25));
    renderCommands();
  }

  if (act === 'info') {
    const text = target.value.trim();
    if (text) command.info = text;
    else delete command.info;
  }

  queueProfileSave();
});

$('addCmd').addEventListener('click', () => {
  let name = 'new';
  let n = 2;
  while (profile.commands.some((c) => c.id === name)) name = `new${n++}`;
  profile.commands.push({ id: name, type: 'key', keys: ['space'], duration: 0.15, allowHold: false });
  renderCommands();
  queueProfileSave();

  const rows = $('cmdList').querySelectorAll('.cmd-row');
  const last = rows[rows.length - 1];
  if (last) {
    last.scrollIntoView({ behavior: 'smooth', block: 'center' });
    last.querySelector('input').select();
  }
});

/* ---------------- setup page ---------------- */

$('platformSeg').addEventListener('click', (event) => {
  const button = event.target.closest('[data-platform]');
  if (button) saveSettings({ platform: button.dataset.platform });
});

function bindText(id, key) {
  const el = $(id);
  let timer = null;
  el.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveSettings({ [key]: el.value }), 500);
  });
}
bindText('twitchChannel', 'twitchChannel');
bindText('youtubeChannel', 'youtubeChannel');

$('copyBtn').addEventListener('click', async () => {
  const url = state?.overlayUrl;
  if (!url) return;
  await navigator.clipboard.writeText(url);
  toast(t('setup.overlay.copied'));
});

/* ---------------- settings page ---------------- */

$('modeSeg').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if (!button) return;
  profile.mode = button.dataset.mode;
  renderSettings();
  queueProfileSave();
});

function bindSlider(id, apply, format) {
  const el = $(id);
  el.addEventListener('input', () => {
    const value = apply(Number(el.value));
    $(`${id}Val`).textContent = format(value);
  });
  el.addEventListener('change', queueProfileSave);
}
bindSlider('voteSeconds', (v) => { profile.voteSeconds = v; return v; }, (v) => `${v} s`);
bindSlider('messageRate', (v) => { profile.messageRate = v / 10; return v / 10; }, (v) => `${v.toFixed(1)} s`);
bindSlider('userCooldown', (v) => { profile.userCooldown = v; return v; },
  (v) => (v === 0 ? t('settings.cooldown.off') : `${v} s`));
bindSlider('maxQueue', (v) => { profile.maxQueue = v; return v; }, (v) => `${v}`);

$('targetWindow').addEventListener('change', (event) => {
  profile.targetWindow = event.target.value;
  queueProfileSave();
});
$('refreshWin').addEventListener('click', () => refreshWindows(true));

$('language').addEventListener('change', async (event) => {
  state = await window.api.saveSettings({ language: event.target.value });
  dict = await window.api.getDictionary(state.language);
  renderAll(true);
});

$('overlayPort').addEventListener('change', (event) => {
  saveSettings({ overlayPort: Number(event.target.value) });
});

async function refreshWindows(notify) {
  const windows = await window.api.listWindows();
  const select = $('targetWindow');
  const current = profile?.targetWindow || '';
  const options = [`<option value="">${esc(t('settings.window.all'))}</option>`];
  for (const title of windows) options.push(`<option value="${esc(title)}">${esc(title)}</option>`);
  if (current && !windows.includes(current)) {
    options.push(`<option value="${esc(current)}">${esc(t('settings.window.closed', { name: current }))}</option>`);
  }
  select.innerHTML = options.join('');
  select.value = current;
  if (notify) toast(t('settings.window.found', { count: windows.length }));
}

/* ---------------- profiles ---------------- */

$('profileSelect').addEventListener('change', async (event) => {
  state = await window.api.switchProfile(event.target.value);
  adoptProfile();
  renderAll(true);
  toast(t('profile.switched', { name: state.profile.name }));
});

$('profileMenuBtn').addEventListener('click', (event) => {
  event.stopPropagation();
  $('profileMenu').classList.toggle('hidden');
});
document.addEventListener('click', () => $('profileMenu').classList.add('hidden'));

$('profileMenu').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  $('profileMenu').classList.add('hidden');
  const act = button.dataset.act;
  const active = state.profile;

  if (act === 'new') {
    const name = await prompt(t('profile.newTitle'), '', t('button.create'));
    if (!name) return;
    state = await window.api.createProfile(name);
    adoptProfile();
    renderAll(true);
    return;
  }

  if (act === 'duplicate') {
    state = await window.api.duplicateProfile(active.id, `${active.name} copy`);
    adoptProfile();
    renderAll(true);
    return;
  }

  if (act === 'rename') {
    const name = await prompt(t('profile.renameTitle'), active.name, t('button.rename'));
    if (!name) return;
    state = await window.api.renameProfile(active.id, name);
    adoptProfile();
    renderAll(true);
    return;
  }

  if (act === 'import') {
    const response = await window.api.importProfile();
    if (response.cancelled) return;
    if (!response.result.ok) {
      toast(response.result.reason === 'noCommands'
        ? t('profile.importNoCommands')
        : t('profile.importFailed'));
      return;
    }
    state = response.state;
    adoptProfile();
    renderAll(true);
    toast(t('profile.imported', { name: response.result.profile.name }));
    return;
  }

  if (act === 'export') {
    const response = await window.api.exportProfile(active.id);
    if (!response.cancelled && response.ok) toast(t('profile.exported'));
    return;
  }

  if (act === 'delete') {
    if (state.profiles.length <= 1) {
      toast(t('profile.deleteLast'));
      return;
    }
    const confirmed = await confirmDialog(
      t('profile.deleteTitle', { name: active.name }),
      t('profile.deleteBody'),
      t('button.delete'),
    );
    if (!confirmed) return;
    const response = await window.api.deleteProfile(active.id);
    if (!response.result.ok) {
      toast(t('profile.deleteLast'));
      return;
    }
    state = response.state;
    adoptProfile();
    renderAll(true);
  }
});

/* ---------------- dialogs ---------------- */

function openDialog({ title, body, value, okLabel, withInput }) {
  return new Promise((resolve) => {
    $('dialogTitle').textContent = title;
    $('dialogBody').textContent = body || '';
    $('dialogBody').classList.toggle('hidden', !body);
    $('dialogInput').classList.toggle('hidden', !withInput);
    $('dialogInput').value = value || '';
    $('dialogInput').placeholder = t('profile.namePlaceholder');
    $('dialogOk').textContent = okLabel;
    $('backdrop').classList.remove('hidden');
    if (withInput) setTimeout(() => $('dialogInput').select(), 30);

    const finish = (result) => {
      $('backdrop').classList.add('hidden');
      $('dialogOk').removeEventListener('click', onOk);
      $('dialogCancel').removeEventListener('click', onCancel);
      $('dialogInput').removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => finish(withInput ? $('dialogInput').value.trim() : true);
    const onCancel = () => finish(null);
    const onKey = (event) => {
      if (event.key === 'Enter') onOk();
      if (event.key === 'Escape') onCancel();
    };

    $('dialogOk').addEventListener('click', onOk);
    $('dialogCancel').addEventListener('click', onCancel);
    $('dialogInput').addEventListener('keydown', onKey);
  });
}

const prompt = (title, value, okLabel) => openDialog({ title, value, okLabel, withInput: true });
const confirmDialog = (title, body, okLabel) => openDialog({ title, body, okLabel, withInput: false });

/* ---------------- run controls ---------------- */

$('mainBtn').addEventListener('click', async () => {
  state = state.running ? await window.api.stop() : await window.api.start();
  renderAll(false);
  if (state.error) toast(t(state.error.key, state.error.vars));
  else if (state.running) showPage('live');
});

$('pauseBtn').addEventListener('click', async () => {
  state = await window.api.togglePause();
  renderAll(false);
});

/* ---------------- updates ---------------- */

function renderUpdate(status) {
  const card = $('updateCard');
  const text = $('updateText');
  const install = $('updateInstall');

  if (!status || status.state === 'idle' || status.state === 'none' || status.state === 'dev') {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  install.classList.toggle('hidden', status.state !== 'ready');

  if (status.state === 'checking') text.textContent = t('update.checking');
  else if (status.state === 'downloading') {
    text.textContent = t('update.available', { version: status.version || '' })
      + (status.percent ? ` ${status.percent}%` : '');
  } else if (status.state === 'ready') {
    text.textContent = `${t('update.ready', { version: status.version || '' })} ${t('update.readyBody')}`;
  } else if (status.state === 'failed') text.textContent = t('update.failed');
}

$('updateInstall').addEventListener('click', () => window.api.installUpdate());

/* ---------------- polls ---------------- */

// Drafted in memory: a poll is usually something she types out and runs
// there and then, not a setting worth keeping.
const pollDraft = {
  question: '',
  options: [{ key: '1', label: '' }, { key: '2', label: '' }],
  durationSeconds: 60,
};

function renderPollOptions() {
  $('pollOptions').innerHTML = pollDraft.options.map((option, index) => `
    <div class="poll-option">
      <input class="inp key-input" data-poll="key" data-index="${index}"
             value="${esc(option.key)}" placeholder="${esc(t('poll.key.placeholder'))}" spellcheck="false">
      <input class="inp" data-poll="label" data-index="${index}"
             value="${esc(option.label)}"
             placeholder="${esc(t('poll.option.placeholder', { n: index + 1 }))}" spellcheck="false">
      <button class="icon-btn del" data-poll="remove" data-index="${index}"
              title="${esc(t('button.delete'))}">&#10005;</button>
    </div>`).join('');
  renderPollClash();
}

/**
 * Poll keys that are also command words. Nothing breaks when they overlap,
 * both simply happen, but it is worth saying so out loud.
 */
function renderPollClash() {
  const words = new Set();
  for (const command of profile?.commands || []) {
    words.add(String(command.id).toLowerCase());
    for (const alias of command.aliases || []) words.add(String(alias).toLowerCase());
  }
  const clashing = pollDraft.options
    .map((option) => option.key.trim().toLowerCase())
    .filter((key) => key && words.has(key));

  const bar = $('pollClash');
  if (clashing.length === 0) {
    bar.classList.add('hidden');
    return;
  }
  const keys = clashing.map((key) => `"${key}"`).join(', ');
  bar.textContent = t(clashing.length === 1 ? 'poll.clash.one' : 'poll.clash.many', { keys });
  bar.classList.remove('hidden');
}

$('pollOptions').addEventListener('input', (event) => {
  const target = event.target.closest('[data-poll]');
  if (!target) return;
  const option = pollDraft.options[Number(target.dataset.index)];
  if (!option) return;
  if (target.dataset.poll === 'key') {
    option.key = target.value;
    renderPollClash();
  }
  if (target.dataset.poll === 'label') option.label = target.value;
});

$('pollOptions').addEventListener('click', (event) => {
  const target = event.target.closest('[data-poll="remove"]');
  if (!target) return;
  if (pollDraft.options.length <= 2) return;
  pollDraft.options.splice(Number(target.dataset.index), 1);
  renderPollOptions();
});

$('pollAddOption').addEventListener('click', () => {
  if (pollDraft.options.length >= 8) return;
  pollDraft.options.push({ key: String(pollDraft.options.length + 1), label: '' });
  renderPollOptions();
  const inputs = $('pollOptions').querySelectorAll('[data-poll="label"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

$('pollQuestion').addEventListener('input', (event) => {
  pollDraft.question = event.target.value;
});

$('pollDuration').addEventListener('input', (event) => {
  pollDraft.durationSeconds = Number(event.target.value);
  $('pollDurationVal').textContent = pollDraft.durationSeconds === 0
    ? t('poll.duration.forever')
    : `${pollDraft.durationSeconds} s`;
});

$('pollStart').addEventListener('click', async () => {
  const response = await window.api.startPoll({
    question: pollDraft.question,
    options: pollDraft.options,
    durationSeconds: pollDraft.durationSeconds,
  });
  state = response.state;
  if (!response.result.ok) toast(t(`error.${response.result.reason}`));
  renderAll(false);
});

$('pollStop').addEventListener('click', async () => {
  state = await window.api.stopPoll();
  renderAll(false);
});

$('pollClose').addEventListener('click', async () => {
  state = await window.api.closePoll();
  renderAll(false);
});

$('pollCopyBtn').addEventListener('click', async () => {
  if (!state || !state.overlayUrl) return;
  await navigator.clipboard.writeText(`${state.overlayUrl}/poll`);
  toast(t('setup.overlay.copied'));
});

function renderPoll() {
  const poll = state.poll;
  const open = poll.status === 'open';
  const closed = poll.status === 'closed';

  $('pollStart').classList.toggle('hidden', open);
  $('pollStop').classList.toggle('hidden', !open);
  $('pollClose').classList.toggle('hidden', !closed);

  const hasChannel = Boolean(state.settings.twitchChannel || state.settings.youtubeChannel);
  $('pollNote').textContent = hasChannel ? '' : t('poll.needChannel');

  $('pollOverlayUrl').textContent = state.overlayUrl ? `${state.overlayUrl}/poll` : '—';

  const card = $('pollLiveCard');
  if (poll.status === 'idle') {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  $('pollLiveTitle').textContent = open ? t('poll.live.title') : t('poll.results.title');

  const fraction = poll.durationSeconds > 0
    ? Math.max(0, Math.min(1, poll.remainingMs / (poll.durationSeconds * 1000)))
    : 0;
  const clock = open && poll.durationSeconds > 0
    ? `<div class="poll-clock">
         <div class="track"><span data-width="${Math.round(fraction * 100)}"></span></div>
         <span class="left">${Math.ceil(poll.remainingMs / 1000)} s</span>
       </div>`
    : '';

  $('pollLive').innerHTML = clock + poll.options.map((option) => `
    <div class="poll-live${option.leading ? ' leading' : ''}">
      <div class="row">
        <span class="key">${esc(option.key)}</span>
        <span class="label">${esc(option.label)}</span>
        <span class="tally"><b>${option.votes}</b> &middot; ${option.percent}%</span>
      </div>
      <div class="vbar"><span data-width="${option.percent}"></span></div>
    </div>`).join('');

  applyBarWidths($('pollLive'));
}

/* ---------------- overlay look ---------------- */

let themeTimer = null;

function theme() {
  return state.settings.overlayTheme;
}

/** Saved on a short delay so dragging a slider is not a burst of writes. */
function queueThemeSave(patch) {
  Object.assign(state.settings.overlayTheme, patch);
  renderTheme();
  clearTimeout(themeTimer);
  themeTimer = setTimeout(async () => {
    state = await window.api.saveSettings({ overlayTheme: state.settings.overlayTheme });
    flashSaved();
    refreshPreviews();
  }, 350);
}

function bindColour(id, key) {
  $(id).addEventListener('input', (event) => queueThemeSave({ [key]: event.target.value }));
}
bindColour('themeAccent', 'accent');
bindColour('themeBackground', 'background');
bindColour('themeText', 'text');

function bindThemeSlider(id, key, toValue) {
  $(id).addEventListener('input', (event) => {
    queueThemeSave({ [key]: toValue(Number(event.target.value)) });
  });
}
bindThemeSlider('themeOpacity', 'opacity', (v) => v / 100);
bindThemeSlider('themeWidth', 'width', (v) => v);
bindThemeSlider('themeRadius', 'radius', (v) => v);
bindThemeSlider('themeScale', 'scale', (v) => v / 100);

$('themeParts').addEventListener('click', (event) => {
  const button = event.target.closest('[data-theme]');
  if (!button) return;
  const key = button.dataset.theme;
  queueThemeSave({ [key]: !theme()[key] });
});

$('themeReset').addEventListener('click', async () => {
  state = await window.api.saveSettings({ overlayTheme: null });
  renderTheme();
  refreshPreviews();
  toast(t('look.wasReset'));
});

/** Reloads the preview frames so they pick the new look straight up. */
function refreshPreviews() {
  if (!state.overlayUrl) return;
  const stamp = Date.now();
  $('previewCommands').src = `${state.overlayUrl}/?preview=${stamp}`;
  $('previewPoll').src = `${state.overlayUrl}/poll?preview=${stamp}`;
}

function renderTheme() {
  const current = theme();
  if (!current) return;

  if (document.activeElement !== $('themeAccent')) $('themeAccent').value = current.accent;
  if (document.activeElement !== $('themeBackground')) $('themeBackground').value = current.background;
  if (document.activeElement !== $('themeText')) $('themeText').value = current.text;

  $('themeOpacity').value = Math.round(current.opacity * 100);
  $('themeOpacityVal').textContent = `${Math.round(current.opacity * 100)}%`;
  $('themeWidth').value = current.width;
  $('themeWidthVal').textContent = `${current.width} px`;
  $('themeRadius').value = current.radius;
  $('themeRadiusVal').textContent = `${current.radius} px`;
  $('themeScale').value = Math.round(current.scale * 100);
  $('themeScaleVal').textContent = `${Math.round(current.scale * 100)}%`;

  for (const button of $('themeParts').querySelectorAll('[data-theme]')) {
    button.classList.toggle('on', Boolean(current[button.dataset.theme]));
  }

  $('previewPollNote').classList.toggle('hidden', state.poll.status !== 'idle');
}

/* ---------------- rendering ---------------- */

function adoptProfile() {
  profile = JSON.parse(JSON.stringify(state.profile));
}

function renderStatus() {
  const engine = state.engine;
  const settings = state.settings;
  const pip = $('pip');
  const channel = settings.platform === 'youtube'
    ? settings.youtubeChannel
    : settings.twitchChannel;

  let cls = 'pip';
  if (engine.paused) cls += ' wait';
  else if (state.anyConnected) cls += ' live';
  else if (state.running) cls += ' wait';
  pip.className = cls;

  if (state.error) {
    $('statusText').textContent = t('status.idle');
    $('statusSub').textContent = t(state.error.key, state.error.vars);
  } else if (engine.paused) {
    $('statusText').textContent = t('status.paused');
    $('statusSub').textContent = t('status.paused.sub', { key: settings.panicKey });
  } else if (state.anyConnected && !engine.windowOk) {
    $('statusText').textContent = t('status.wrongWindow', { window: engine.targetWindow });
    $('statusSub').textContent = t('status.wrongWindow.sub');
  } else if (state.anyConnected) {
    $('statusText').textContent = t('status.live', { channel });
    $('statusSub').textContent = t(`status.live.${engine.mode}`);
  } else if (state.running) {
    $('statusText').textContent = t('status.connecting');
    $('statusSub').textContent = t('status.connecting.sub');
  } else {
    $('statusText').textContent = t('status.idle');
    $('statusSub').textContent = t('status.idle.sub');
  }

  $('total').textContent = engine.total;
  $('mainBtn').textContent = state.running ? t('button.stop') : t('button.start');
  $('mainBtn').className = `btn ${state.running ? 'stop' : 'go'}`;
  $('pauseBtn').classList.toggle('hidden', !state.running);
  $('pauseBtn').textContent = engine.paused ? t('button.resume') : t('button.pause');
  $('pauseBtn').className = `btn ghost${engine.paused ? ' paused' : ''}`;
}

function renderSetup() {
  const settings = state.settings;
  for (const button of document.querySelectorAll('#platformSeg button')) {
    button.classList.toggle('on', button.dataset.platform === settings.platform);
  }
  $('twitchCard').classList.toggle('hidden', settings.platform === 'youtube');
  $('youtubeCard').classList.toggle('hidden', settings.platform === 'twitch');

  if (document.activeElement !== $('twitchChannel')) $('twitchChannel').value = settings.twitchChannel;
  if (document.activeElement !== $('youtubeChannel')) $('youtubeChannel').value = settings.youtubeChannel;

  $('overlayUrl').textContent = state.overlayUrl
    || (state.overlayError ? t(state.overlayError.key, state.overlayError.vars) : '—');
}

function renderSettings() {
  for (const button of document.querySelectorAll('#modeSeg button')) {
    button.classList.toggle('on', button.dataset.mode === profile.mode);
  }
  const democracy = profile.mode === 'democracy';
  $('modeHelp').textContent = t(`settings.mode.${profile.mode}.help`);
  $('voteField').classList.toggle('hidden', !democracy);
  $('rateField').classList.toggle('hidden', democracy);

  $('voteSeconds').value = profile.voteSeconds;
  $('voteSecondsVal').textContent = `${profile.voteSeconds} s`;
  $('messageRate').value = Math.round(profile.messageRate * 10);
  $('messageRateVal').textContent = `${Number(profile.messageRate).toFixed(1)} s`;
  $('userCooldown').value = profile.userCooldown;
  $('userCooldownVal').textContent = profile.userCooldown === 0
    ? t('settings.cooldown.off') : `${profile.userCooldown} s`;
  $('maxQueue').value = profile.maxQueue;
  $('maxQueueVal').textContent = `${profile.maxQueue}`;

  if (document.activeElement !== $('overlayPort')) $('overlayPort').value = state.settings.overlayPort;
}

function renderProfiles() {
  const select = $('profileSelect');
  select.innerHTML = state.profiles
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join('');
  select.value = state.profile.id;
}

// Bar widths come from a constructed stylesheet rather than a style
// attribute on each bar: the page's own Content-Security-Policy forbids
// inline styles, and setting them anyway filled the console with warnings.
// Percentages are whole numbers, so all 101 rules fit in one sheet written
// once at startup and the markup just carries data-width.
const barWidths = new CSSStyleSheet();
barWidths.replaceSync(
  Array.from({ length: 101 }, (_, i) => `[data-width="${i}"]{width:${i}%}`).join(''),
);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, barWidths];

function applyBarWidths() {
  // Nothing to do: the data-width attribute styles itself.
}

let lastLiveKey = '';

function renderLive(force) {
  const engine = state.engine;
  // Rebuilding identical markup restarts each row's entry animation,
  // so only touch the DOM when the content actually changed.
  const key = JSON.stringify([engine.mode, engine.feed, engine.votes, engine.lastWinner]);
  if (!force && key === lastLiveKey) return;
  lastLiveKey = key;

  const democracy = engine.mode === 'democracy';
  $('liveLeftTitle').textContent = democracy ? t('live.votes') : t('live.recent');

  if (democracy) {
    if (engine.votes.length === 0) {
      $('liveLeft').innerHTML = `<div class="empty">${esc(t('live.waitingVotes'))}</div>`;
    } else {
      const max = Math.max(...engine.votes.map((v) => v.votes));
      $('liveLeft').innerHTML = engine.votes.map((v) => `
        <div class="vote${v.votes === max ? ' lead' : ''}">
          <div class="lbl"><span>${esc(v.id)}</span><b>${v.votes}</b></div>
          <div class="vbar"><span data-width="${Math.round((v.votes / max) * 100)}"></span></div>
        </div>`).join('')
        + (engine.lastWinner
          ? `<div class="sub">${esc(t('live.lastWinner', {
            name: `${engine.lastWinner.id} (${engine.lastWinner.votes})`,
          }))}</div>` : '');
    }
  } else if (engine.feed.length === 0) {
    $('liveLeft').innerHTML = `<div class="empty">${esc(t('live.waiting'))}</div>`;
  } else {
    $('liveLeft').innerHTML = `<ul class="feed">${engine.feed.map((entry) => `
      <li class="${entry.kind === 'blocked' ? 'blocked' : ''}">
        <span class="u">${esc(entry.user)}</span>
        <span class="c">${esc(entry.command)}</span>
        ${entry.kind === 'blocked' ? `<span class="why">${esc(t('live.blocked'))}</span>` : ''}
        <span class="plat">${esc(entry.platform)}</span>
      </li>`).join('')}</ul>`;
  }

  const tally = new Map();
  for (const entry of engine.feed) {
    if (entry.kind === 'blocked') continue;
    const name = entry.command.split(' ')[0];
    tally.set(name, (tally.get(name) || 0) + 1);
  }
  applyBarWidths($('liveLeft'));

  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length === 0) {
    $('liveRight').innerHTML = `<div class="empty">${esc(t('live.noActivity'))}</div>`;
  } else {
    const max = top[0][1];
    $('liveRight').innerHTML = top.map(([name, count]) => `
      <div class="vote">
        <div class="lbl"><span>${esc(name)}</span><b>${count}</b></div>
        <div class="vbar"><span data-width="${Math.round((count / max) * 100)}"></span></div>
      </div>`).join('');
  }
  applyBarWidths($('liveRight'));
}

function renderAll(full) {
  if (full) {
    applyDictionary();
    renderCommands();
  }
  renderStatus();
  renderSetup();
  renderSettings();
  renderProfiles();
  renderProblems();
  renderLive(full);
  renderPoll();
  renderTheme();
  if (full) renderPollOptions();
}

/* ---------------- start ---------------- */

(async function init() {
  info = await window.api.getAppInfo();
  state = await window.api.getState();
  dict = await window.api.getDictionary(state.language);
  adoptProfile();

  $('language').innerHTML = `<option value="auto">${esc(t('settings.language.auto'))}</option>`
    + info.languages.map((l) => `<option value="${esc(l.code)}">${esc(l.name)}</option>`).join('');
  $('language').value = state.settings.language;
  $('version').textContent = t('update.current', { version: info.version });

  $('pollDuration').value = pollDraft.durationSeconds;
  $('pollDurationVal').textContent = `${pollDraft.durationSeconds} s`;

  renderAll(true);
  await refreshWindows(false);
  renderUpdate(await window.api.getUpdateStatus());

  window.api.onStateChanged((next) => {
    state = next;
    renderStatus();
    renderLive();
    renderProblems();
    renderPoll();
  });

  // The vote countdown moves on its own, so the poll page ticks while open.
  setInterval(() => {
    if (currentPage === 'poll' && state && state.poll.status === 'open') renderPoll();
  }, 500);
  window.api.onUpdateChanged(renderUpdate);

}());
