// scripts/clock.js
const DC_ID   = "doomsday-clock";
const CHANNEL = `module.${DC_ID}`;

let totalMinutes = 0; // start at 00:00

/* ── Init: register world setting and react on ALL clients ── */
Hooks.once("init", () => {
  game.settings.register(DC_ID, "totalMinutes", {
    scope: "world",
    config: false,
    type: Number,
    default: 0, // midnight
    onChange: (value) => {
      // Fires on every user when the setting changes (GM or API)
      totalMinutes = Math.max(0, Number(value) || 0);
      const app = DoomsdayClock.instance();
      if (app.rendered) app._draw();
    }
  });
});

/* ── Ready: load saved time, add toolbar button, open for everyone, wire socket ── */
Hooks.once("ready", () => {
  const saved = Number(game.settings.get(DC_ID, "totalMinutes"));
  totalMinutes = Number.isFinite(saved) ? saved : 0;

  // Scene Controls button
  Hooks.on("getSceneControlButtons", (controls) => {
    controls.push({
      name: "doomsdayclock",
      title: "Doomsday Clock",
      icon: "fa-regular fa-clock",
      visible: true,
      tools: [{
        name: "open",
        title: "Open Clock",
        icon: "fa-regular fa-clock",
        button: true,
        onClick: () => DoomsdayClock.instance().render(true)
      }]
    });
  });

  // Open the clock window for ALL users
  DoomsdayClock.instance().render(true);

  // Instant replication channel (in addition to settings onChange)
  game.socket.on(CHANNEL, (msg) => {
    if (!msg || msg.type !== "sync") return;
    DoomsdayClock.instance()._setTime(msg.value);
  });
});

/* ── Application ── */
class DoomsdayClock extends Application {
  static #inst;
  static _didAutoResetSync = false; // run Reset→Sync once per session after first render

  static instance() { return this.#inst ??= new DoomsdayClock(); }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "doomsday-clock-app",
      title: "Doomsday Clock",
      template: `modules/${DC_ID}/templates/clock.html`,
      width: 340,
      height: 340,
      popOut: true,
      resizable: false
    });
  }

  async _renderInner(data, options) {
    const html = await super._renderInner(data, options);

    // GM-only controls
    if (!game.user.isGM) html.find(".clock-controls").hide();

    // Wire buttons
    const on = (a, fn) => html.find(`[data-action='${a}']`).off("click").on("click", fn);
    on("-5m", () => this._bump(-5));
    on("-1h", () => this._bump(-60));
    on("+5m", () => this._bump(+5));
    on("+1h", () => this._bump(+60));
    on("reset", () => this._reset());
    on("sync",  () => this._sync());

    // First draw
    this._draw();

    // After first render of the session: Reset then Sync (GM only)
    if (game.user.isGM && !DoomsdayClock._didAutoResetSync) {
      DoomsdayClock._didAutoResetSync = true;
      await this._reset();
      await this._sync();
    }

    return html;
  }

  /* Local setter used by socket + settings onChange */
  _setTime(next) {
    const n = Math.max(0, Number(next) || 0);
    totalMinutes = n;
    this._draw();
  }

  /* GM: adjust time, persist, and broadcast */
  _bump(delta) {
    if (!game.user.isGM) return;
    const next = Math.max(0, (Number(totalMinutes) || 0) + delta);

    // Immediate local update
    this._setTime(next);

    // Persist → triggers onChange on all users
    game.settings.set(DC_ID, "totalMinutes", next);

    // Broadcast → instant client update even before settings round-trip
    game.socket.emit(CHANNEL, { type: "sync", value: next });
  }

  /* GM: Reset to midnight, persist, broadcast */
  async _reset() {
    if (!game.user.isGM) return;
    const next = 0;
    this._setTime(next);
    await game.settings.set(DC_ID, "totalMinutes", next);
    game.socket.emit(CHANNEL, { type: "sync", value: next });
  }

  /* GM: Force clients to re-sync to current value */
  async _sync() {
    if (!game.user.isGM) return;
    const val = Number(totalMinutes) || 0;
    // Touch the setting (some builds still fire onChange even for same value)
    await game.settings.set(DC_ID, "totalMinutes", val);
    // And always push via socket for immediate replication
    game.socket.emit(CHANNEL, { type: "sync", value: val });
  }

  /* Draw: set rotation angles only (placement is 100% CSS) */
  _draw() {
    const mod = ((totalMinutes % 1440) + 1440) % 1440;
    const h = Math.floor(mod / 60);
    const m = mod % 60;

    const minuteDeg = m * 6;                    // 6° per minute
    const hourDeg   = (h % 12) * 30 + m * 0.5;  // 30°/hr + 0.5°/min
    const base = -90;                            // art points right → "up" is -90°

    const el = this.element;
    const minEl = el.find(".dc-minute")[0];
    const hrEl  = el.find(".dc-hour")[0];
    if (minEl) minEl.style.setProperty("--angle", `${base + minuteDeg}deg`);
    if (hrEl)  hrEl.style.setProperty("--angle",  `${base + hourDeg}deg`);
  }
}
