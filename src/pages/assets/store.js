'use strict';

(async function () {
  const api = window.swiftly;
  const { el, emptyState, applyTheme } = window.swiftlyPage || {};
  await applyTheme?.();

  const balanceEl = document.getElementById('balance');
  const themesEl = document.getElementById('themes');
  const extensionsEl = document.getElementById('extensions');

  let catalog = null;

  async function loadCatalog() {
    catalog = await api.store.catalog();
    renderBalance();
    renderThemes();
    renderExtensions();
  }

  function renderBalance() {
    balanceEl.textContent = `${catalog.searches} search${catalog.searches === 1 ? '' : 'es'}`;
  }

  function renderThemes() {
    themesEl.textContent = '';
    if (!catalog.themes.length) {
      themesEl.appendChild(emptyState('No themes available'));
      return;
    }
    for (const theme of catalog.themes) {
      const card = document.createElement('div');
      card.className = 'theme-card' + (theme.active ? ' active' : '');

      const preview = document.createElement('div');
      preview.className = 'theme-preview';
      if (theme.vars) {
        preview.style.background = theme.vars['--bg'] || '#fff';
        preview.style.color = theme.vars['--text'] || '#000';
        const accent = document.createElement('span');
        accent.className = 'theme-accent';
        accent.style.background = theme.vars['--accent'] || '#3b6f63';
        preview.appendChild(accent);
      } else {
        preview.style.background = 'linear-gradient(135deg, #f7f7f4, #121418)';
      }

      const body = document.createElement('div');
      body.className = 'theme-body';
      const name = document.createElement('div');
      name.className = 'theme-name';
      name.textContent = theme.name;
      const desc = document.createElement('div');
      desc.className = 'theme-desc';
      desc.textContent = theme.description;
      body.appendChild(name);
      body.appendChild(desc);

      const footer = document.createElement('div');
      footer.className = 'theme-footer';
      const cost = document.createElement('span');
      cost.className = 'theme-cost';
      cost.textContent = theme.cost === 0 ? 'Free' : `${theme.cost} searches`;
      footer.appendChild(cost);

      const action = document.createElement('button');
      action.className = 'button' + (theme.active ? ' primary' : '');
      action.type = 'button';
      if (theme.active) {
        action.textContent = 'Applied';
        action.disabled = true;
      } else if (theme.owned) {
        action.textContent = 'Apply';
        action.addEventListener('click', async () => {
          const prefs = await api.store.applyTheme(theme.id);
          if (prefs && !prefs.error) {
            await loadCatalog();
            await applyTheme?.();
          }
        });
      } else {
        action.textContent = `Buy for ${theme.cost}`;
        action.addEventListener('click', async () => {
          const result = await api.store.purchaseTheme(theme.id);
          if (result && result.error) {
            alert(result.error);
            return;
          }
          // Apply immediately after purchase.
          await api.store.applyTheme(theme.id);
          await loadCatalog();
          await applyTheme?.();
        });
      }
      footer.appendChild(action);

      card.appendChild(preview);
      card.appendChild(body);
      card.appendChild(footer);
      themesEl.appendChild(card);
    }
  }

  function renderExtensions() {
    extensionsEl.textContent = '';
    if (!catalog.extensions.length) {
      extensionsEl.appendChild(emptyState('No extensions available', 'star'));
      return;
    }
    for (const ext of catalog.extensions) {
      const row = document.createElement('div');
      row.className = 'list-row';

      const icon = document.createElement('span');
      icon.className = 'list-icon';
      icon.textContent = ext.name.charAt(0).toUpperCase();
      icon.style.background = '#3b6f63';
      icon.style.color = '#fff';
      icon.style.fontWeight = '700';
      row.appendChild(icon);

      const body = document.createElement('div');
      body.className = 'list-body';
      const title = document.createElement('div');
      title.className = 'list-title';
      title.textContent = ext.name;
      const meta = document.createElement('div');
      meta.className = 'list-meta';
      meta.textContent = ext.description;
      body.appendChild(title);
      body.appendChild(meta);
      row.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'list-actions';
      actions.style.opacity = '1';

      if (ext.installed) {
        const toggle = document.createElement('button');
        toggle.className = 'button';
        toggle.type = 'button';
        toggle.textContent = ext.enabled ? 'Disable' : 'Enable';
        toggle.addEventListener('click', async () => {
          await api.store.toggleExtension(ext.id, !ext.enabled);
          await loadCatalog();
        });
        actions.appendChild(toggle);

        const extDef = catalog.extensions.find((e) => e.id === ext.id);
        // Only allow uninstall for non-builtins; check via name? Use catalog? We'll just attempt.
        const remove = document.createElement('button');
        remove.className = 'button danger';
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', async () => {
          const res = await api.store.uninstallExtension(ext.id);
          if (res && res.error) alert(res.error);
          await loadCatalog();
        });
        actions.appendChild(remove);
      } else {
        const install = document.createElement('button');
        install.className = 'button primary';
        install.type = 'button';
        install.textContent = 'Install';
        install.addEventListener('click', async () => {
          await api.store.installExtension(ext.id);
          await loadCatalog();
        });
        actions.appendChild(install);
      }

      row.appendChild(actions);
      extensionsEl.appendChild(row);
    }
  }

  await loadCatalog();
})();