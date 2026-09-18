'use strict';
/* ─── Auto-update ───────────────────────────────────────────────────────────
   Main-process only. The user decides every step:
     · CHECK — 10 s after launch, then every 6 h, and only while the "Check for
       updates automatically" preference is on. Off = check() returns before
       electron-updater is touched, so no network request is made at all.
     · DOWNLOAD — never automatic. A found update is offered as a sheet on the
       main window: Download / Skip This Version / Later.
     · INSTALL — only when the user picks Restart in the dialog shown after the
       download. "Later" installs nothing, on quit or otherwise.
     · Errors are logged and never shown. A failed check means the machine is
       offline or GitHub is down — neither is worth a dialog.
     · NEVER interrupt an encode. quitAndInstall() would terminate ffmpeg
       mid-write and leave a partial with no moov atom. Both the offer sheet and
       the restart prompt are held while a queue runs; main.js calls
       notifyIdle() when it drains.

   Packaged builds only. In dev (`npm start`) it stays off unless
   SKINNYVIDEO_DEV_UPDATER=1, which points it at the real GitHub feed and logs
   every request the updater's network session makes — the way to verify that
   the preference really stops all traffic.

   The feed itself is package.json's build.publish → latest-mac.yml,
   published as a GitHub release asset. */

const { app, dialog: electronDialog, session } = require('electron');

/* Late enough not to compete with window creation and the first paint. */
const FIRST_CHECK_DELAY_MS = 10 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const log = (msg) => console.log(`[SkinnyVideo] updater: ${msg}`);
const NOOP = { notifyIdle() {}, check() {} };

/* deps.isBusy()      — true while a queue is running or finalizing.
   deps.getWindow()   — the window to parent the restart dialog on, or null.
   deps.isEnabled()   — the "Check for updates automatically" preference.
   deps.isSkipped(v)  — true if the user chose "Skip This Version" for v.
   deps.onSkip(v)     — persist that choice.
   deps.dialog        — test seam; defaults to electron's dialog module.
   deps.autoUpdater   — test seam; defaults to electron-updater's instance.
   Returns { notifyIdle, check }; a no-op object when updates are off. */
function installUpdater(deps = {}) {
  const fn = (f, fallback) => (typeof f === 'function' ? f : fallback);
  const isBusy = fn(deps.isBusy, () => false);
  const getWindow = fn(deps.getWindow, () => null);
  const isEnabled = fn(deps.isEnabled, () => true);
  const isSkipped = fn(deps.isSkipped, () => false);
  const onSkip = fn(deps.onSkip, () => {});
  const dialog = deps.dialog || electronDialog;

  /* Both prompts are sheets on the main window when there is one. */
  const ask = (opts) => {
    const win = getWindow();
    return (win && !win.isDestroyed()) ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  };

  let autoUpdater = deps.autoUpdater;
  const devForced = !app.isPackaged && process.env.SKINNYVIDEO_DEV_UPDATER === '1';
  if (!autoUpdater) {
    if (!app.isPackaged && !devForced) {
      log('development build — auto-update disabled');
      return NOOP;
    }
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch (e) {
      /* A packaged build with no updater is degraded, not broken: the app still
         compresses video. Loud in the log, silent on screen. */
      log(`electron-updater could not be loaded, auto-update is off: ${(e && e.message) || e}`);
      return NOOP;
    }
    if (devForced) {
      autoUpdater.forceDevUpdateConfig = true;
      /* Dev only: point the check at a local feed instead of the GitHub release,
         so the offer sheet can be exercised without publishing anything.
         Ignored in a packaged build — devForced is false there. */
      const devFeed = process.env.SKINNYVIDEO_DEV_FEED_URL;
      if (devFeed) {
        autoUpdater.setFeedURL({ provider: 'generic', url: devFeed });
        log(`dev build — feed overridden by SKINNYVIDEO_DEV_FEED_URL: ${devFeed}`);
      } else {
        autoUpdater.setFeedURL(require('../../package.json').build.publish[0]);
      }
      /* Same partition + options electron-updater opens for its own requests. */
      session.fromPartition('electron-updater', { cache: false }).webRequest
        .onBeforeRequest((d, cb) => { log(`network request: ${d.method} ${d.url}`); cb({}); });
      log('dev build — forced on by SKINNYVIDEO_DEV_UPDATER=1');
    }
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (m) => log(String(m)),
    warn: (m) => log(`warn: ${String(m)}`),
    error: (m) => log(`error: ${String(m)}`),
    debug: () => {},
  };

  let available = null;    // info for a found update the user has not answered
  let pending = null;      // info for a downloaded update not yet acted on
  let dialogOpen = false;  // never stack two restart prompts
  let offerOpen = false;   // never stack two offer sheets

  autoUpdater.on('checking-for-update', () => log('checking for an update'));
  autoUpdater.on('update-not-available', () => log('already up to date'));
  autoUpdater.on('update-available', (info) => {
    const version = info && info.version;
    if (isSkipped(version)) {
      log(`update ${version} available — the user chose to skip it, not offered`);
      return;
    }
    available = info || {};
    log(`update available: ${version} — asking before downloading`);
    flush();
  });

  /* Log only. See the header: an update error is never worth a dialog. */
  autoUpdater.on('error', (err) => {
    log(`check or download failed (staying on the current version): ${(err && err.message) || err}`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    pending = info || {};
    log(`update downloaded: ${pending.version}`);
    flush();
  });

  /* Show whatever is waiting — unless a queue is running. */
  function flush() {
    if (!available && !pending) return;
    if (isBusy()) {
      log(`holding the update ${pending ? 'restart prompt' : 'offer'} — a queue is still running`);
      return;
    }
    if (pending) prompt();
    else offer();
  }

  /* The offer sheet: Download / Skip This Version / Later. Nothing downloads
     until the operator picks Download. */
  function offer() {
    if (offerOpen || !available) return;
    offerOpen = true;
    const info = available;
    const version = info.version || 'A new version';
    ask({
      type: 'info',
      buttons: ['Download', 'Skip This Version', 'Later'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,     // plain buttons, never a "Skip This Version" link
      message: `SkinnyVideo ${version} is available`,
      detail: 'Download it now? You can install it whenever you’re ready.',
    }).then(({ response }) => {
      offerOpen = false;
      available = null;
      if (response === 0) {
        log(`downloading ${version} — the user chose Download`);
        Promise.resolve(autoUpdater.downloadUpdate()).catch(() => { /* logged by 'error' */ });
      } else if (response === 1) {
        onSkip(version);
        log(`skipping ${version} — the user chose Skip This Version`);
      } else {
        log(`update ${version} deferred — offered again on a later check`);
      }
    }).catch((e) => {
      offerOpen = false;
      log(`could not show the update offer: ${(e && e.message) || e}`);
    });
  }

  function prompt() {
    if (dialogOpen) return;
    dialogOpen = true;
    const version = pending.version || 'A new version';
    const opts = {
      type: 'info',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `SkinnyVideo ${version} is ready. Restart now?`,
      detail: 'If you choose Later, nothing is installed. SkinnyVideo will offer the update again on a later check.',
    };
    ask(opts).then(({ response }) => {
      dialogOpen = false;
      if (response === 0) {
        log(`restarting to install ${version}`);
        /* Off this tick so the dialog is fully dismissed before the quit
           sequence starts. */
        setImmediate(() => {
          try { autoUpdater.quitAndInstall(); }
          catch (e) { log(`quitAndInstall failed: ${(e && e.message) || e}`); }
        });
      } else {
        /* autoInstallOnAppQuit is false, so declining really installs nothing. */
        pending = null;
        log(`restart declined — ${version} is not installed`);
      }
    }).catch((e) => {
      dialogOpen = false;
      log(`could not show the restart prompt: ${(e && e.message) || e}`);
    });
  }

  const check = () => {
    if (!isEnabled()) {
      log('automatic update checks are off — no request made');
      return;
    }
    try { Promise.resolve(autoUpdater.checkForUpdates()).catch(() => { /* logged by 'error' */ }); }
    catch (e) { log(`check could not start: ${(e && e.message) || e}`); }
  };

  const first = setTimeout(check, FIRST_CHECK_DELAY_MS);
  const repeat = setInterval(check, CHECK_INTERVAL_MS);
  /* Timers must not hold the event loop open on quit. */
  if (first.unref) first.unref();
  if (repeat.unref) repeat.unref();

  return {
    /* Called by main.js when a run ends: flushes anything held back mid-encode. */
    notifyIdle: flush,
    check,
  };
}

module.exports = { installUpdater, FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS };
