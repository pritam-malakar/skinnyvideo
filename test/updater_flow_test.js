/* Updater flow (src/main/updater.js) against a fake autoUpdater and a fake
   dialog — no network, no real sheet.
   Proves: pref off → no check; nothing downloads until the operator picks
   Download; the offer sheet carries the three buttons; Skip persists and that
   version is never offered again; Later defers; the offer waits for an idle
   queue; a downloaded update never installs itself.
   Run: ./node_modules/.bin/electron test/updater_flow_test.js */
const { app } = require('electron');
const path = require('path');
const { EventEmitter } = require('events');
const { installUpdater } = require(path.join(__dirname, '..', 'src/main/updater'));

const FAIL = [];
const check = (c, l) => { if (!c) FAIL.push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const tick = () => new Promise((r) => setImmediate(r));

app.whenReady().then(async () => {
  const fake = new EventEmitter();
  fake.checks = 0; fake.downloads = 0; fake.installs = 0;
  fake.checkForUpdates = () => { fake.checks++; return Promise.resolve(null); };
  fake.downloadUpdate = () => { fake.downloads++; return Promise.resolve([]); };
  fake.quitAndInstall = () => { fake.installs++; };

  let enabled = false;
  let busy = false;
  const skipped = [];
  const shown = [];            // every dialog the updater put up
  let answer = 2;              // index the fake dialog returns
  const fakeDialog = {
    showMessageBox: (...args) => {
      const opts = args.length > 1 ? args[1] : args[0];
      shown.push({ parented: args.length > 1, opts });
      return Promise.resolve({ response: answer });
    },
  };
  const offers = () => shown.filter((s) => s.opts.buttons[0] === 'Download');

  const u = installUpdater({
    autoUpdater: fake,
    dialog: fakeDialog,
    isEnabled: () => enabled,
    isBusy: () => busy,
    isSkipped: (v) => skipped.includes(v),
    onSkip: (v) => skipped.push(v),
    getWindow: () => null,     // no window in this harness → unparented box
  });

  check(fake.autoDownload === false, 'autoDownload is off');
  check(fake.autoInstallOnAppQuit === false, 'autoInstallOnAppQuit is off — Later never installs on quit');

  u.check();
  check(fake.checks === 0, 'pref OFF → checkForUpdates never called');
  enabled = true;
  u.check();
  check(fake.checks === 1, 'pref ON → checkForUpdates called');

  // ── hold-back: nothing on screen while a queue runs
  busy = true;
  answer = 2;
  fake.emit('update-available', { version: '9.9.9' });
  await tick();
  check(offers().length === 0, 'offer held while a queue runs');
  busy = false;
  u.notifyIdle();
  await tick();
  check(offers().length === 1, 'offer shown once the queue drains');
  const o = offers()[0].opts;
  check(o.type === 'info' && o.message === 'SkinnyVideo 9.9.9 is available',
    `message names the version (type=${o.type}, message="${o.message}")`);
  check(o.detail === 'Download it now? You can install it whenever you’re ready.', `detail is the one-liner: "${o.detail}"`);
  check(JSON.stringify(o.buttons) === JSON.stringify(['Download', 'Skip This Version', 'Later']),
    `buttons are Download / Skip This Version / Later (${JSON.stringify(o.buttons)})`);
  check(o.defaultId === 0 && o.cancelId === 2 && o.noLink === true,
    `defaultId=0, cancelId=2, noLink=true (got ${o.defaultId}, ${o.cancelId}, ${o.noLink})`);
  check(fake.downloads === 0, 'Later (the answer above) downloads nothing');

  // ── Later: offered again on the next check
  fake.emit('update-available', { version: '9.9.9' });
  await tick();
  check(offers().length === 2, 'a deferred version is offered again on a later check');
  check(fake.downloads === 0, 'still nothing downloaded');

  // ── Download
  answer = 0;
  fake.emit('update-available', { version: '9.9.9' });
  await tick();
  check(fake.downloads === 1, 'Download → downloadUpdate');

  // ── Skip This Version
  answer = 1;
  fake.emit('update-available', { version: '9.9.10' });
  await tick();
  check(skipped.join() === '9.9.10', 'Skip This Version → persisted via onSkip');
  const before = offers().length;
  fake.emit('update-available', { version: '9.9.10' });
  await tick();
  check(offers().length === before, 'a skipped version is never offered again');
  check(fake.downloads === 1, 'Skip downloads nothing');

  // ── one sheet at a time
  answer = 2;
  let release;
  fakeDialog.showMessageBox = (...args) => {
    shown.push({ parented: args.length > 1, opts: args.length > 1 ? args[1] : args[0] });
    return new Promise((r) => { release = () => r({ response: 2 }); });
  };
  fake.emit('update-available', { version: '9.9.11' });
  await tick();
  const open = offers().length;
  fake.emit('update-available', { version: '9.9.12' });
  await tick();
  check(offers().length === open, 'a second find never stacks a second sheet');
  release();
  await tick();

  // ── the post-download prompt is unchanged
  fakeDialog.showMessageBox = (...args) => {
    const opts = args.length > 1 ? args[1] : args[0];
    shown.push({ parented: args.length > 1, opts });
    return Promise.resolve({ response: 1 });   // Later
  };
  busy = true;
  fake.emit('update-downloaded', { version: '9.9.9' });
  await tick();
  check(fake.installs === 0, 'a downloaded update does not install by itself');
  const restarts = shown.filter((s) => s.opts.buttons[0] === 'Restart');
  check(restarts.length === 0, 'restart prompt held while a queue runs');
  busy = false;
  u.notifyIdle();
  await tick();
  const r = shown.filter((s) => s.opts.buttons[0] === 'Restart');
  check(r.length === 1 && JSON.stringify(r[0].opts.buttons) === JSON.stringify(['Restart', 'Later']),
    `restart prompt unchanged: ${JSON.stringify(r[0] && r[0].opts.buttons)}`);
  check(fake.installs === 0, 'Later on the restart prompt installs nothing');

  console.log(FAIL.length ? `\n${FAIL.length} FAILED` : '\nALL PASS');
  app.exit(FAIL.length ? 1 : 0);
});
