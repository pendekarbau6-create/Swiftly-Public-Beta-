'use strict';

/**
 * Development helper: render the window to PNG and PDF files.
 *
 *   electron . --shot <dir> [delayMs] [url]
 *
 * The shell and the active page are captured separately because a child view
 * does not appear in its parent's screenshot. The shell normally has a
 * transparent background so it can float over the page; for the capture it is
 * temporarily given an opaque one, otherwise the screenshot comes back empty.
 */

const path = require('node:path');
const fs = require('node:fs');

/**
 * @param {object} options
 * @param {import('electron').BrowserWindow} options.window
 * @param {string} options.outputDir
 * @param {number} options.delay
 * @param {string} [options.url]
 * @param {string} [options.script] JavaScript to run in the shell before capture
 */
async function capture({ window, outputDir, delay = 2500, url = '', script = '' }) {
  fs.mkdirSync(outputDir, { recursive: true });

  const controller = window.__swiftlyController;

  // Wait for the first page to settle so a navigation is not aborted by it.
  if (controller?.activeTab) {
    const tab = controller.activeTab;
    if (tab.loading) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 8000);
        tab.webContents.once('did-stop-loading', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  if (url && controller) {
    console.log(`[swiftly] navigating to ${url}`);
    controller.navigate(controller.activeTabId, url);
    // Give the page time to run its own network work.
    await new Promise((resolve) => setTimeout(resolve, 7000));
  }

  await new Promise((resolve) => setTimeout(resolve, delay));

  const writePng = async (webContents, name) => {
    if (!webContents || webContents.isDestroyed()) return;
    try {
      const image = await webContents.capturePage();
      const buffer = image.toPNG();
      const file = path.join(outputDir, `${name}.png`);
      fs.writeFileSync(file, buffer);
      console.log(`[swiftly] captured ${file} (${buffer.length} bytes)`);
    } catch (error) {
      console.error(`[swiftly] png capture failed for ${name}:`, error.message);
    }
  };

  const writePdf = async (webContents, name) => {
    if (!webContents || webContents.isDestroyed()) return;
    try {
      const data = await webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { marginType: 'none' },
      });
      const file = path.join(outputDir, `${name}.pdf`);
      fs.writeFileSync(file, data);
      console.log(`[swiftly] rendered ${file} (${data.length} bytes)`);
    } catch (error) {
      console.error(`[swiftly] pdf render failed for ${name}:`, error.message);
    }
  };

  if (script && controller?.shellView) {
    try {
      const result = await controller.shellView.webContents.executeJavaScript(script, true);
      console.log(`[swiftly] eval => ${JSON.stringify(result)}`);
    } catch (error) {
      console.error(`[swiftly] eval failed:`, error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }

  // Read the active tab only after any scripted work has finished.
  const activeTab = controller?.activeTab;

  console.log(`[swiftly] window visible=${window.isVisible()} tab=${activeTab ? activeTab.url : 'none'}`);

  if (activeTab) {
    await writePng(activeTab.webContents, 'page');
    await writePdf(activeTab.webContents, 'page');
  }

  if (controller?.shellView) {
    controller.shellView.setBackgroundColor('#ffffff');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await writePng(controller.shellView.webContents, 'shell');
    controller.shellView.setBackgroundColor('#00000000');
  }

  return { outputDir };
}

module.exports = { capture };
