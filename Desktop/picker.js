(function (root) {
  'use strict';
  const spacer = '|';

  function normalize(keys, saved) {
    const order = [];
    let spaces = 0;
    const given = Array.isArray(saved?.order) ? saved.order : keys.flatMap(key => key === 'notemind' ? [spacer, key] : [key]);
    for (const key of given) {
      if (key === spacer && spaces < keys.length) { order.push(key); spaces++; }
      else if (keys.includes(key) && !order.includes(key)) order.push(key);
    }
    for (const key of keys) if (!order.includes(key)) order.push(key);
    const hidden = keys.filter(key => Array.isArray(saved?.hidden) && saved.hidden.includes(key));
    if (hidden.length === keys.length) hidden.shift();
    return { order, hidden };
  }

  function visible(config) {
    return config.order.filter(key => key !== spacer && !config.hidden.includes(key));
  }

  function customize({ dialog, trigger, catalog, getConfig, save }) {
    const rows = dialog.querySelector('[data-picker-rows]');
    const add = dialog.querySelector('[data-picker-add]');
    const labels = new Map(catalog.map(app => [app.key, app.label]));
    let draft, dragged = null;
    const keys = [...labels.keys()];

    function action(text, label, click, disabled = false) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.disabled = disabled;
      button.onclick = click;
      return button;
    }

    function move(from, to) {
      if (from === to) return;
      const [item] = draft.order.splice(from, 1);
      draft.order.splice(to, 0, item);
      draw();
    }

    function draw() {
      rows.replaceChildren();
      for (const [index, key] of draft.order.entries()) {
        const name = labels.get(key) || 'Spacer';
        const row = document.createElement('li');
        row.draggable = true;
        row.ondragstart = event => { dragged = index; event.dataTransfer.setData('text/plain', name); };
        row.ondragend = () => { dragged = null; };
        row.ondragover = event => { if (dragged !== null) event.preventDefault(); };
        row.ondrop = event => {
          event.preventDefault();
          if (dragged === null) return;
          const box = row.getBoundingClientRect();
          const position = index + (event.clientY > box.top + box.height / 2 ? 1 : 0);
          move(dragged, position - (dragged < position ? 1 : 0));
          dragged = null;
        };

        const nameLabel = document.createElement(key === spacer ? 'span' : 'label');
        if (key !== spacer) {
          const check = document.createElement('input');
          check.type = 'checkbox';
          check.checked = !draft.hidden.includes(key);
          check.disabled = check.checked && visible(draft).length === 1;
          check.onchange = () => {
            draft.hidden = check.checked ? draft.hidden.filter(other => other !== key) : [...draft.hidden, key];
            for (const checkbox of rows.querySelectorAll('input')) checkbox.disabled = checkbox.checked && visible(draft).length === 1;
          };
          nameLabel.append(check);
        }
        nameLabel.append(name);
        row.append(nameLabel,
          action('↑', 'Move ' + name + ' up', () => move(index, index - 1), index === 0),
          action('↓', 'Move ' + name + ' down', () => move(index, index + 1), index === draft.order.length - 1));
        if (key === spacer) row.append(action('×', 'Remove spacer', () => { draft.order.splice(index, 1); draw(); }));
        rows.append(row);
      }
      add.disabled = draft.order.filter(key => key === spacer).length >= keys.length;
    }

    trigger.onclick = () => {
      draft = normalize(keys, getConfig());
      draw();
      dialog.showModal();
    };
    add.onclick = () => { draft.order.push(spacer); draw(); };
    dialog.querySelector('[data-picker-cancel]').onclick = () => dialog.close();
    dialog.querySelector('[data-picker-save]').onclick = () => {
      save(normalize(keys, draft));
      dialog.close();
    };
  }

  const picker = { spacer, normalize, visible, customize };
  if (typeof module !== 'undefined') module.exports = picker;
  else root.MindSuitePicker = picker;
}(globalThis));
