// scripts/clock.js
const DC_ID = "doomsday-clock";
const CHANNEL = `module.${DC_ID}`;

let totalMinutes = 0; // start at 00:00

/* ── Init: register world setting and react on ALL clients ── */
Hooks.once("init", () => {
  game.settings.register(DC_ID, "totalMinutes", {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
    onChange: (value) => {
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

  DoomsdayClock.instance().render(true);

  game.socket.on(CHANNEL, (msg) => {
    if (!msg || msg.type !== "sync") return;
    DoomsdayClock.instance()._setTime(msg.value);
  });
});

/* ── Application ── */
class DoomsdayClock extends Application {
  static #inst;
  static _didAutoResetSync = false;

  static instance() {
    return this.#inst ??= new DoomsdayClock();
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "doomsday-clock-app",
      title: "Doomsday Clock",
      template: `modules/${DC_ID}/templates/clock.html`,
      width: 380,
      height: 420,
      popOut: true,
      resizable: false
    });
  }

  _lastHourDeg = 0;
  _lastMinuteDeg = 0;

  activateListeners(html) {
    super.activateListeners(html);

    // GM-only controls
    if (!game.user.isGM) html.find(".control-panel").hide();

    // Wire buttons (safe re-bind on each render)
    const on = (action, fn) => {
      html.find(`[data-action='${action}']`).off("click").on("click", fn);
    };
    on("+1h", () => this._bump(+60));
    on("-1h", () => this._bump(-60));
    on("+5m", () => this._bump(+5));
    on("-5m", () => this._bump(-5));
    on("reset", () => this._reset());
    on("sync",  () => this._sync());
    on("+1d", () => this._bumpDays(+1));
    on("-1d", () => this._bumpDays(-1));
    on("day-reset", () => this._dayReset());

    // First paint after each render
    this._draw();

    // One-time auto Reset→Sync for the GM
    if (game.user.isGM && !DoomsdayClock._didAutoResetSync) {
      DoomsdayClock._didAutoResetSync = true;
      this._reset().then(() => this._sync());
    }
  }

  _setTime(next) {
    const n = Math.max(0, Number(next) || 0);
    const delta = n - totalMinutes;
    totalMinutes = n;
    this._draw(delta);
  }


  _bump(delta) {
    if (!game.user.isGM) return;
    const next = Math.max(0, (Number(totalMinutes) || 0) + delta);
    this._setTime(next);
    game.settings.set(DC_ID, "totalMinutes", next);
    game.socket.emit(CHANNEL, { type: "sync", value: next });
  }

  async _reset() {
    if (!game.user.isGM) return;
    const next = totalMinutes - (totalMinutes % 1440); // start of current day
    this._setTime(next);
    await game.settings.set(DC_ID, "totalMinutes", next);
    game.socket.emit(CHANNEL, { type: "sync", value: next });
  }

  async _sync() {
    if (!game.user.isGM) return;
    const val = Number(totalMinutes) || 0;
    await game.settings.set(DC_ID, "totalMinutes", val);
    game.socket.emit(CHANNEL, { type: "sync", value: val });
  }

  _bumpDays(delta) {
    const deltaMinutes = delta * 1440;
    this._bump(deltaMinutes);
  }

async _dayReset() {
  if (!game.user.isGM) return;
  const cur = Math.max(0, Number(totalMinutes) || 0);
  const next = Math.floor(cur / 1440) * 1440; // 00:00 same day
  this._setTime(next);
  await game.settings.set(DC_ID, "totalMinutes", next);
  game.socket.emit(CHANNEL, { type: "sync", value: next });
}


  _normalizeRotation(prev, next, forward) {
    if (forward) {
      while (next < prev) next += 360;
    } else {
      while (next > prev) next -= 360;
    }
    return next;
  }

  _draw(delta = 0) {
    // Minutes → hours/minutes within the day
    const mod = ((totalMinutes % 1440) + 1440) % 1440;
    const h = Math.floor(mod / 60);
    const m = mod % 60;

    // Grab elements once
    const el     = this.element;
    const minEl  = el.find(".minute-hand")[0];
    const hrEl   = el.find(".hour-hand")[0];
    const dayEl  = el.find(".day-counter")[0]; // was .day-label (incorrect)

    // Target angles (0–360), art points right → add base later
    const rawMinuteDeg = m * 6;                       // 6° per minute
    const rawHourDeg   = (h % 12) * 30 + m * 0.5;     // 30°/hr + 0.5°/min
    const base = -90;

    // First-run init of continuity state
    if (!Number.isFinite(this._lastMinuteDeg)) this._lastMinuteDeg = rawMinuteDeg;
    if (!Number.isFinite(this._lastHourDeg))   this._lastHourDeg   = rawHourDeg;

    // Direction hint from caller (positive=forward, negative=backward)
    const forward = delta >= 0;

    // Normalize to intended direction (shortest path respecting sign)
    const minuteDeg = this._normalizeRotation(this._lastMinuteDeg, rawMinuteDeg, forward);
    const hourDeg   = this._normalizeRotation(this._lastHourDeg,   rawHourDeg,   forward);

    // Persist continuity state
    this._lastMinuteDeg = minuteDeg;
    this._lastHourDeg   = hourDeg;

    // Paint
    if (minEl) minEl.style.transform = `rotate(${base + minuteDeg}deg)`;
    if (hrEl)  hrEl.style.transform  = `rotate(${base + hourDeg}deg)`;

    // HUD: Day N
    if (dayEl) {
      const day = Math.floor(totalMinutes / 1440) + 1;
      dayEl.textContent = `Day ${day}`;
    }
  }


}
