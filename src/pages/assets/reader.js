'use strict';

(() => {
  const { applyTheme } = window.swiftlyPage;
  const api = window.swiftly;
  const article = document.getElementById('reader-article');
  const source = document.getElementById('reader-source');
  let fontSize = 19;

  function setFontSize(value) {
    fontSize = Math.max(16, Math.min(28, value));
    article.style.setProperty('--reader-font-size', `${fontSize}px`);
  }

  function render(content) {
    document.title = `${content.title} — Speed Reader`;
    article.textContent = '';
    article.appendChild(document.createElement('h1')).textContent = content.title;
    if (content.author) {
      article.appendChild(document.createElement('p')).className = 'reader-author';
      article.lastChild.textContent = content.author;
    }

    for (const block of content.content || []) {
      const tag = ['h1', 'h2', 'h3', 'p'].includes(block.tag) ? block.tag : 'p';
      const node = document.createElement(tag);
      node.textContent = block.text;
      article.appendChild(node);
    }

    try {
      source.textContent = new URL(content.source).hostname;
    } catch {
      source.textContent = '';
    }
  }

  document.getElementById('reader-close').addEventListener('click', async () => {
    const result = await api.reader.toggle(api.currentTabId);
    if (!result?.ok) article.prepend(Object.assign(document.createElement('p'), {
      className: 'reader-error',
      textContent: result?.error || 'Could not return to the original page.',
    }));
  });
  document.getElementById('font-smaller').addEventListener('click', () => setFontSize(fontSize - 1));
  document.getElementById('font-larger').addEventListener('click', () => setFontSize(fontSize + 1));

  applyTheme()
    .then(() => api.reader.content(api.currentTabId))
    .then((content) => {
      if (!content?.content?.length) throw new Error('No readable article text is available.');
      render(content);
    })
    .catch((error) => {
      article.textContent = '';
      article.appendChild(Object.assign(document.createElement('p'), {
        className: 'reader-error',
        textContent: error.message || 'Could not load this article.',
      }));
    });
})();
