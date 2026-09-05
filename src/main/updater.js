'use strict';
/* ─── Auto-update ───────────────────────────────────────────────────────────
   Main-process only. No renderer changes, no in-app UI: the single moment the
   user sees anything is a native dialog once a new version is already on disk.

   Shape of the thing:
     · Packaged builds only. In dev there is no code signature and no feed, so
       electron-updater is never even required — `npm start` must stay silent.
     · autoDownload: the update arrives in the background; the user is asked
       only about restarting, which is the sole decision that is actually
       theirs to make.
     · autoInstallOnAppQuit: declining the restart costs nothing. The update
       is applied on the next quit either way, so "Later" is genuinely free
       and we never have to ask twice.
     · Errors are logged and never shown. A failed check means the machine is
       offline or GitHub is down — neither is the user's problem, and a dialog
       about it would be pure noise on every flight and coffee-shop wifi.
     · NEVER interrupt an encode. quitAndInstall() would terminate ffmpeg
       mid-write and leave a partial with no moov atom — the same corruption
       the close-guard exists to prevent. If the download lands mid-run the
       prompt is held until the queue drains (main.js calls notifyIdle()).

   The feed itself is package.json's build.publish → dist/latest-mac.yml,
   published as a GitHub release asset. */

const path = require('path');
const { app, dialog } = require('electron');

/* Late enough not to compete with window creation and the first paint. */
const FIRST_CHECK_DELAY_MS = 10 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const log = (msg) => console.log(`[SkinnyVideo] updater: ${msg}`);

/* deps.isBusy()    — true while a queue is running or finalizing.
   deps.getWindow() — the window to parent the dialog on, or null.
   Returns { notifyIdle } so main.js can flush a deferred prompt when the
   queue drains; a no-op object in dev so callers need no guard. */
function installUpdater(deps = {}) {
  const isBusy = typeof deps.isBusy === 'function' ? deps.isBusy : () => false;
  const getWindow = typeof deps.getWindow === 'function' ? deps.getWindow : () => null;

  if (!app.isPackaged) {
    log('development build — auto-update disabled');
    return { notifyIdle() {} };
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    /* A packaged build with no updater is degraded, not broken: the app still
       compresses video. Loud in the log, silent on screen. */
    log(`electron-updater could not be loaded, auto-update is off: ${(e && e.message) || e}`);
    return { notifyIdle() {} };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => log(String(m)),
    warn: (m) => log(`warn: ${String(m)}`),
    error: (m) => log(`error: ${String(m)}`),
    debug: () => {},
  };

  let pending = null;      // info for a downloaded update not yet acted on
  let dialogOpen = false;  // never stack two restart prompts

  autoUpdater.on('checking-for-update', () => log('checking for an update'));
  autoUpdater.on('update-available', (info) => log(`update available: ${info && info.version} — downloading`));
  autoUpdater.on('update-not-available', () => log('already up to date'));

  /* Log only. See the header: an update error is never worth a dialog. */
  autoUpdater.on('error', (err) => {
    log(`check or download failed (staying on the current version): ${(err && err.message) || err}`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    pending = info || {};
    log(`update downloaded: ${pending.version}`);
    maybePrompt();
  });

  function maybePrompt() {
    if (!pending || dialogOpen) return;
    if (isBusy()) {
      log(`holding the restart prompt for ${pending.version} — a queue is still running`);
      return;
    }
    dialogOpen = true;
    const version = pending.version || 'A new version';
    const win = getWindow();
    const opts = {
      type: 'info',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `SkinnyVideo ${version} is ready. Restart now?`,
      detail: 'If you choose Later, the update is applied the next time you quit SkinnyVideo.',
    };
    const shown = win && !win.isDestroyed()
      ? dialog.showMessageBox(win, opts)
      : dialog.showMessageBox(opts);

    shown.then(({ response }) => {
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
        /* Cleared so the 6-hourly checks never re-ask about a version the
           user has already deferred. autoInstallOnAppQuit still applies it. */
        pending = null;
        log(`restart deferred — ${version} installs on next quit`);
      }
    }).catch((e) => {
      dialogOpen = false;
      log(`could not show the restart prompt: ${(e && e.message) || e}`);
    });
  }

  const check = () => {
    try { autoUpdater.checkForUpdates(); }
    catch (e) { log(`check could not start: ${(e && e.message) || e}`); }
  };

  const first = setTimeout(check, FIRST_CHECK_DELAY_MS);
  const repeat = setInterval(check, CHECK_INTERVAL_MS);
  /* Timers must not hold the event loop open on quit. */
  if (first.unref) first.unref();
  if (repeat.unref) repeat.unref();

  return {
    /* Called by main.js when a run ends: flushes a prompt held back mid-encode. */
    notifyIdle() { maybePrompt(); },
  };
}

module.exports = { installUpdater, FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS };
