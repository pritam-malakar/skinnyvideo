/* Updater flow (src/main/updater.js) against a fake autoUpdater — no network.
   Proves: pref off → no check; nothing downloads without a click; Later and
   Skip behave; the notice waits for an idle queue; Later never installs.
   Run: ./node_modules/.bin/electron test/updater_flow_test.js */
const { app } = require('electron');
const path = require('path');
const { EventEmitter } = require('events');
const { installUpdater } = require(path.join(__dirname, '..', 'src/main/updater'));

const FAIL = [];
const check = (c, l) => { if (!c) FAIL.push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

app.whenReady().then(() => {
  const fake = new EventEmitter();
  fake.checks = 0; fake.downloads = 0; fake.installs = 0;
  fake.checkForUpdates = () => { fake.checks++; return Promise.resolve(null); };
  fake.downloadUpdate = () => { fake.downloads++; return Promise.resolve([]); };
  fake.quitAndInstall = () => { fake.installs++; };

  let enabled = false;
  let busy = false;
  const notices = [];
  const skipped = [];
  const u = installUpdater({
    autoUpdater: fake,
    isEnabled: () => enabled,
    isBusy: () => busy,
    isSkipped: (v) => skipped.includes(v),
    onSkip: (v) => skipped.push(v),
    showNotice: (v) => notices.push(v),
  });

  check(fake.autoDownload === false, 'autoDownload is off');
  check(fake.autoInstallOnAppQuit === false, 'autoInstallOnAppQuit is off — Later never installs on quit');

  u.check();
  check(fake.checks === 0, 'pref OFF → checkForUpdates never called');
  enabled = true;
  u.check();
  check(fake.checks === 1, 'pref ON → checkForUpdates called');

  busy = true;
  fake.emit('update-available', { version: '9.9.9' });
  check(notices.length === 0, 'notice held while a queue runs');
  busy = false;
  u.notifyIdle();
  check(notices.join() === '9.9.9', 'notice shown once the queue drains');
  check(fake.downloads === 0, 'nothing downloaded without a click');

  u.act('later');
  u.act('download');
  check(fake.downloads === 0, 'Later dismisses; a stale Download click afterwards does nothing');

  fake.emit('update-available', { version: '9.9.9' });
  u.act('download');
  check(fake.downloads === 1, 'Download click → downloadUpdate');

  fake.emit('update-available', { version: '9.9.10' });
  u.act('skip');
  fake.emit('update-available', { version: '9.9.10' });
  check(skipped.join() === '9.9.10', 'Skip this version → persisted');
  check(notices.filter((v) => v === '9.9.10').length === 1, 'a skipped version is never offered again');

  busy = true;
  fake.emit('update-downloaded', { version: '9.9.9' });
  check(fake.installs === 0, 'a downloaded update does not install by itself');

  console.log(FAIL.length ? `\n${FAIL.length} FAILED` : '\nALL PASS');
  app.exit(FAIL.length ? 1 : 0);
});
