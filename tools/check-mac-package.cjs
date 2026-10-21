'use strict';
// Launch the distributable itself, after extracting the ZIP, on a clean Mac runner.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict'), asar = require('@electron/asar');
const { _electron } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const root = path.join(__dirname, '..'), version = require('../package.json').version;
const dist = path.join(root, 'dist/mac-preview'), output = path.join(root, 'output/playwright/mac-package');
if (process.platform !== 'darwin') throw Error('Run the packaged Mac smoke test on macOS');
fs.mkdirSync(output, { recursive: true });
const unpacked = path.join(dist, 'mac-arm64/提示词助手.app');
const zip = path.join(dist, `PromptAssistant-${version}-mac-arm64.zip`);
const dmg = path.join(dist, `提示词助手-${version}-mac-arm64.dmg`);
const extracted = fs.mkdtempSync(path.join(output, 'zip-'));
cp.execFileSync('ditto', ['-xk', zip, extracted]);
const bundle = path.join(extracted, '提示词助手.app');
const archive = path.join(bundle, 'Contents/Resources/app.asar');
assert(fs.readFileSync(archive).equals(fs.readFileSync(path.join(unpacked, 'Contents/Resources/app.asar'))));
for (const file of ['main.js', 'preload.js', 'lib/feishu.js', 'src/panel.js', 'src/settings.js']) {
  assert(fs.readFileSync(path.join(root, file)).equals(asar.extractFile(archive, file)), 'Packaged source mismatch: ' + file);
}
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
cp.execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]);
cp.execFileSync('hdiutil', ['verify', dmg]);

(async () => {
  const env = { ...process.env, PREVIEW_SETTINGS: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/提示词助手'), env, timeout: 30000 });
  const errors = []; app.on('window', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const panel = await app.firstWindow();
    await panel.waitForURL('**/panel.html');
    await panel.waitForFunction(() => !!window.api?.getData);
    const data = await panel.evaluate(() => window.api.getData());
    assert.equal(data.view.prompts.length, 0);
    const cfg = await panel.evaluate(() => window.api.getConfig());
    assert.equal(cfg.baseToken, ''); assert.equal(cfg.baseUrl, ''); assert.equal(cfg.sources.length, 0);
    const state = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, platform: process.platform, arch: process.arch, version: app.getVersion(), dockVisible: app.dock.isVisible() }));
    assert.deepEqual(state, { packaged: true, platform: 'darwin', arch: 'arm64', version, dockVisible: false });
    await panel.evaluate(() => window.api.requestExpand(true));
    await panel.waitForFunction(() => getComputedStyle(document.querySelector('#panel')).opacity === '1');
    await panel.screenshot({ path: path.join(output, 'panel.png') });
    const settings = app.windows().find(page => page.url().endsWith('/settings.html'));
    assert(settings, 'Packaged settings did not load');
    await settings.waitForFunction(() => document.querySelector('#launchAtLoginLabel')?.textContent.includes('Mac'));
    assert((await settings.locator('#userDataPath').textContent()).includes('Library/Application Support'));
    await settings.screenshot({ path: path.join(output, 'settings.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: signed ZIP app launches on Apple Silicon; panel, settings, Dock hiding and clean initial profile verified. DMG integrity verified.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
