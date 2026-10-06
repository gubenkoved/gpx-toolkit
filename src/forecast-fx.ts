/**
 * GPX Toolkit — forecast map weather effects.
 *
 * When the user hovers an hour on the forecast chart, the map shows that hour's
 * weather: a full-map canvas overlay of drifting wind streaks whose speed and
 * heading follow the forecast, plus — when the hour is wet — rain in the air and
 * raindrops ON the glass: droplets land on the map as if on a window, sit and
 * evaporate, and the big ones trickle down leaving wet trails. Spawn rate, count
 * and drop size all scale with the hour's millimetres, so a drizzle is a few
 * beads and a downpour is a streaming pane. It is a single-point forecast, so the
 * whole viewport shares one wind vector — the point is to *feel* the hour, not to
 * map a field. Respects `prefers-reduced-motion` (one static frame, no trickle).
 * Pure canvas, no dependencies; the view owns the lifecycle.
 */

export interface WeatherSnapshot {
  /** Meteorological direction the wind blows FROM, degrees clockwise from north. */
  fromDeg: number;
  /** Mean wind speed, km/h. */
  speedKmh: number;
  /** Precipitation for the hour, mm (0 = dry). */
  rainMm: number;
  /** Cloud cover, 0–100. */
  cloudPct: number;
  /** Speed text as the user sees it elsewhere (unit-converted). */
  speedLabel: string;
}

interface Streak {
  x: number;
  y: number;
  age: number;
  life: number;
}

interface Drop {
  x: number;
  y: number;
  speed: number;
  len: number;
}

/** A raindrop sitting on the glass. */
interface GlassDrop {
  x: number;
  y: number;
  /** Radius in px; grows a little while it sits (collecting water). */
  r: number;
  age: number;
  /** Seconds before a sitting drop evaporates (trickling drops ignore this). */
  life: number;
  /** Downward trickle speed, px/s (0 = still sitting). */
  vy: number;
  /** Per-drop horizontal wobble phase, so trails don't all run dead straight. */
  wobble: number;
  /** Wet trail left behind while trickling, in px (fades as it lengthens). */
  trail: number;
}

const D2R = Math.PI / 180;
/** The hour's millimetres at which the glass effect saturates (a cycling downpour). */
const RAIN_FULL_MM = 3;
/** A drop this big is heavy enough to start running down the glass. */
const TRICKLE_R = 5.2;

/** Animated wind streaks + rain over a map container. */
export class WeatherFx {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private host: HTMLElement | null = null;
  private raf = 0;
  private last = 0;
  private snap: WeatherSnapshot | null = null;
  private streaks: Streak[] = [];
  private drops: Drop[] = [];
  private glass: GlassDrop[] = [];
  /** Fractional drops owed to the glass this frame (spawn-rate accumulator). */
  private glassAcc = 0;
  private fade = 0; // 0..1 overlay opacity, eased in/out
  private reduced = false;

  attach(host: HTMLElement): void {
    if (this.host === host) return;
    this.detach();
    this.host = host;
    const canvas = document.createElement("canvas");
    canvas.className = "fc-fx";
    canvas.setAttribute("aria-hidden", "true");
    host.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  detach(): void {
    this.stop();
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.host = null;
  }

  /** Show this hour's weather (null = fade out). */
  set(snap: WeatherSnapshot | null): void {
    this.snap = snap;
    if (!this.canvas || !this.ctx) return;
    if (snap && this.reduced) {
      // No motion: a single static frame is still informative.
      this.fade = 1;
      this.resize();
      this.frame(0, true);
      return;
    }
    if (snap && !this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.fade = 0;
    this.streaks = [];
    this.drops = [];
    this.glass = [];
    this.glassAcc = 0;
    if (this.canvas && this.ctx)
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private resize(): void {
    if (!this.canvas || !this.host) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private tick = (now: number): void => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const target = this.snap ? 1 : 0;
    this.fade += (target - this.fade) * Math.min(1, dt * 6);
    if (!this.snap && this.fade < 0.02) {
      this.stop();
      return;
    }
    this.resize();
    this.frame(dt, false);
    this.raf = requestAnimationFrame(this.tick);
  };

  private frame(dt: number, still: boolean): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    const snap = this.snap;
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!snap) return;
    const styles = getComputedStyle(document.documentElement);
    const streakColor = styles.getPropertyValue("--fx-streak").trim() || "255, 255, 255";
    const rainColor = styles.getPropertyValue("--fx-rain").trim() || "120, 180, 255";
    const travel = (snap.fromDeg + 180) * D2R;
    const vx = Math.sin(travel);
    const vy = -Math.cos(travel);
    const speed = snap.speedKmh;

    // -- wind streaks: density and pace grow with the wind ---------------------
    const want = Math.round((Math.min(220, 40 + speed * 3) * (w * h)) / (1200 * 500));
    while (this.streaks.length < want) this.streaks.push(this.spawnStreak(w, h));
    if (this.streaks.length > want) this.streaks.length = want;
    const px = 30 + speed * 6; // px per second
    const len = 8 + Math.min(40, speed * 0.9);
    ctx.lineCap = "round";
    ctx.lineWidth = 1.2;
    for (const s of this.streaks) {
      if (!still) {
        s.x += vx * px * dt;
        s.y += vy * px * dt;
        s.age += dt;
        if (s.age > s.life || s.x < -len || s.x > w + len || s.y < -len || s.y > h + len) {
          Object.assign(s, this.spawnStreak(w, h));
        }
      }
      const t = s.age / s.life;
      const alpha = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 0.55 * this.fade;
      ctx.strokeStyle = `rgba(${streakColor}, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(s.x - vx * len, s.y - vy * len);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
    }

    // -- rain: falls with a drift from the wind --------------------------------
    const rain = snap.rainMm;
    const wantDrops =
      rain > 0 ? Math.round((Math.min(600, 40 + rain * 160) * (w * h)) / (1200 * 500)) : 0;
    while (this.drops.length < wantDrops) this.drops.push(this.spawnDrop(w, h, true));
    if (this.drops.length > wantDrops) this.drops.length = wantDrops;
    if (wantDrops) {
      const drift = vx * Math.min(220, speed * 5);
      ctx.lineWidth = 1;
      for (const d of this.drops) {
        if (!still) {
          d.y += d.speed * dt;
          d.x += drift * dt;
          if (d.y > h + d.len || d.x < -40 || d.x > w + 40)
            Object.assign(d, this.spawnDrop(w, h, false));
        }
        ctx.strokeStyle = `rgba(${rainColor}, ${(0.45 * this.fade).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(d.x - (drift / Math.max(1, d.speed)) * d.len, d.y - d.len);
        ctx.lineTo(d.x, d.y);
        ctx.stroke();
      }
      // A faint wash so a wet hour reads even before the drops register.
      ctx.fillStyle = `rgba(${rainColor}, ${(Math.min(0.12, rain * 0.04) * this.fade).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    this.glassFrame(ctx, w, h, dt, still, rain, styles);
  }

  // -- raindrops on the glass ----------------------------------------------------
  /** Spawn, move and draw the droplets sitting on (and running down) the pane.
   *  `rain` (mm for the hour) drives everything: spawn rate, population cap and
   *  drop size. A dry hour stops spawning and lets what's there evaporate. */
  private glassFrame(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    dt: number,
    still: boolean,
    rain: number,
    styles: CSSStyleDeclaration,
  ): void {
    const intensity = Math.max(0, Math.min(1, rain / RAIN_FULL_MM));
    const area = (w * h) / (1200 * 500);
    const cap = Math.round((intensity > 0 ? 30 + 260 * intensity : 0) * area);
    if (still) {
      // One static frame: seed a representative population and draw it once.
      this.glass = [];
      for (let i = 0; i < cap; i++)
        this.glass.push(this.spawnGlassDrop(w, h, intensity, true));
    } else if (intensity > 0 && this.glass.length < cap) {
      // Spawn rate ramps with the rain: a drizzle beads slowly, a downpour streams.
      this.glassAcc += (3 + 70 * intensity) * area * dt;
      while (this.glassAcc >= 1 && this.glass.length < cap) {
        this.glassAcc -= 1;
        this.glass.push(this.spawnGlassDrop(w, h, intensity, false));
      }
    }
    if (!this.glass.length) return;
    const sprites = this.glassSprites(styles);

    const keep: GlassDrop[] = [];
    const runners: GlassDrop[] = [];
    for (const d of this.glass) {
      if (!still) {
        d.age += dt;
        if (d.vy === 0) {
          // Sitting: swell a touch, then start running once heavy enough.
          d.r += (0.25 + 1.4 * intensity) * dt;
          if (d.r > TRICKLE_R && Math.random() < dt * (0.4 + 1.6 * intensity)) {
            d.vy = 18 + (d.r - TRICKLE_R) * 22 + Math.random() * 20;
          }
        } else {
          d.vy += 24 * dt; // gravity wins slowly
          d.y += d.vy * dt;
          d.x += Math.sin(d.age * 3 + d.wobble) * 9 * dt;
          d.trail = Math.min(110, d.trail + d.vy * dt);
          if (d.y > h + d.r * 3) continue; // ran off the pane
          runners.push(d);
          // A run sheds tiny beads behind it now and then.
          if (this.glass.length < cap && Math.random() < dt * 2.5) {
            keep.push({
              x: d.x + (Math.random() - 0.5) * d.r,
              y: d.y - d.r * 2 - Math.random() * 8,
              r: 0.9 + Math.random() * 1.1,
              age: 0,
              life: 3 + Math.random() * 4,
              vy: 0,
              wobble: 0,
              trail: 0,
            });
          }
        }
        // Dry hour, or an old sitting drop: evaporate. Trickling drops run off instead.
        const evaporating = intensity === 0 || (d.vy === 0 && d.age > d.life);
        if (evaporating) {
          d.r -= (intensity === 0 ? 4 : 1.6) * dt;
          if (d.r <= 0.6) continue;
        }
      }
      keep.push(d);
    }
    // A running drop swallows the sitting drops it passes over and grows by them.
    if (!still && runners.length) {
      for (let i = keep.length - 1; i >= 0; i--) {
        const d = keep[i];
        if (d.vy !== 0) continue;
        for (const run of runners) {
          const dx = d.x - run.x;
          const dy = d.y - run.y;
          if (dx * dx + dy * dy < (run.r + d.r * 0.6) ** 2) {
            run.r = Math.min(14, Math.sqrt(run.r * run.r + d.r * d.r * 0.6));
            keep.splice(i, 1);
            break;
          }
        }
      }
    }
    this.glass = keep;

    // Draw small to large so the big runners sit on top.
    keep.sort((p, q) => p.r - q.r);
    const alpha = this.fade;
    for (const d of keep) {
      if (d.trail > 0) this.drawTrail(ctx, d, sprites.trail, alpha);
      if (d.vy > 0) {
        // Runner: an elongated lens (1.5× taller than wide), head at the bottom.
        const sw = d.r * 2.2;
        ctx.globalAlpha = alpha;
        ctx.drawImage(sprites.run, d.x - sw / 2, d.y - sw * 0.95, sw, sw * 1.5);
      } else {
        const sw = d.r * 2.4;
        ctx.globalAlpha = alpha * (d.r < 1.4 ? 0.7 : 1);
        ctx.drawImage(sprites.bead, d.x - sw / 2, d.y - sw / 2, sw, sw);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** The wet streak a runner leaves: a soft tapered band that fades upward. */
  private drawTrail(
    ctx: CanvasRenderingContext2D,
    d: GlassDrop,
    color: string,
    alpha: number,
  ): void {
    const grad = ctx.createLinearGradient(d.x, d.y - d.trail, d.x, d.y);
    grad.addColorStop(0, `rgba(${color}, 0)`);
    grad.addColorStop(1, `rgba(${color}, ${(0.09 * alpha).toFixed(3)})`);
    ctx.fillStyle = grad;
    const wTop = Math.max(0.5, d.r * 0.22);
    const wBot = d.r * 0.72;
    ctx.beginPath();
    ctx.moveTo(d.x - wTop, d.y - d.trail);
    ctx.lineTo(d.x + wTop, d.y - d.trail);
    ctx.lineTo(d.x + wBot, d.y);
    ctx.lineTo(d.x - wBot, d.y);
    ctx.closePath();
    ctx.fill();
  }

  private spriteKey = "";
  private sprites: { bead: HTMLCanvasElement; run: HTMLCanvasElement; trail: string } | null =
    null;

  /** Pre-shaded drop sprites (rebuilt when the theme's drop tokens change). Shading
   *  mimics a lens on glass: a soft dark edge, a faintly tinted body, a bright
   *  crescent where light refracts through the lower edge, a sharp glint up top —
   *  and no outline, which is what made the first version read as bubbles. */
  private glassSprites(styles: CSSStyleDeclaration): {
    bead: HTMLCanvasElement;
    run: HTMLCanvasElement;
    trail: string;
  } {
    const fill = styles.getPropertyValue("--fx-drop-fill").trim() || "190, 215, 255";
    const edge = styles.getPropertyValue("--fx-drop-edge").trim() || "10, 18, 32";
    const glint = styles.getPropertyValue("--fx-drop-glint").trim() || "255, 255, 255";
    const key = `${fill}|${edge}|${glint}`;
    if (this.sprites && this.spriteKey === key) return this.sprites;
    this.spriteKey = key;

    const S = 96; // sprite width; the drop body spans ~84% of it
    const shade = (
      ctx: CanvasRenderingContext2D,
      cx: number,
      cy: number,
      r: number,
      clipPath: () => void,
    ): void => {
      ctx.save();
      clipPath();
      ctx.clip();
      // Body: tinted centre, darkening towards a soft edge.
      let g = ctx.createRadialGradient(cx - r * 0.1, cy - r * 0.15, r * 0.1, cx, cy, r);
      g.addColorStop(0, `rgba(${fill}, 0.06)`);
      g.addColorStop(0.6, `rgba(${fill}, 0.12)`);
      g.addColorStop(0.88, `rgba(${edge}, 0.14)`);
      g.addColorStop(1, `rgba(${edge}, 0.3)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S * 2);
      // Refracted light: a bright crescent along the lower-right edge.
      g = ctx.createRadialGradient(
        cx + r * 0.22,
        cy + r * 0.3,
        r * 0.45,
        cx + r * 0.22,
        cy + r * 0.3,
        r * 0.98,
      );
      g.addColorStop(0, `rgba(${glint}, 0)`);
      g.addColorStop(0.72, `rgba(${glint}, 0)`);
      g.addColorStop(0.9, `rgba(${glint}, 0.38)`);
      g.addColorStop(1, `rgba(${glint}, 0.05)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S * 2);
      // Specular glint: a small sharp highlight, upper left.
      g = ctx.createRadialGradient(
        cx - r * 0.38,
        cy - r * 0.42,
        0,
        cx - r * 0.38,
        cy - r * 0.42,
        r * 0.34,
      );
      g.addColorStop(0, `rgba(${glint}, 0.9)`);
      g.addColorStop(0.35, `rgba(${glint}, 0.45)`);
      g.addColorStop(1, `rgba(${glint}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S * 2);
      ctx.restore();
    };

    const bead = document.createElement("canvas");
    bead.width = S;
    bead.height = S;
    const bc = bead.getContext("2d")!;
    const br = S * 0.42;
    shade(bc, S / 2, S / 2, br, () => {
      bc.beginPath();
      bc.ellipse(S / 2, S / 2, br * 0.96, br, 0, 0, Math.PI * 2);
    });

    // Runner: the same lens stretched tall (1.5:1), its weight low in the sprite.
    const run = document.createElement("canvas");
    run.width = S;
    run.height = Math.round(S * 1.5);
    const rc = run.getContext("2d")!;
    const rx = S * 0.36;
    const ry = S * 0.62;
    const rcy = run.height * 0.55;
    shade(rc, S / 2, rcy + ry * 0.15, ry * 0.9, () => {
      rc.beginPath();
      rc.ellipse(S / 2, rcy, rx, ry, 0, 0, Math.PI * 2);
    });

    this.sprites = { bead, run, trail: fill };
    return this.sprites;
  }

  private spawnGlassDrop(w: number, h: number, intensity: number, seeded: boolean): GlassDrop {
    // Heavier rain lands bigger drops; a seeded (static) frame also gets a few runners.
    const r = 1.3 + (2 + 7.5 * intensity) * Math.random() ** 1.7;
    const runner = seeded && r > TRICKLE_R && Math.random() < 0.5;
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      r,
      age: seeded ? Math.random() * 3 : 0,
      life: 4 + Math.random() * 7,
      vy: runner ? 30 : 0,
      wobble: Math.random() * Math.PI * 2,
      trail: runner ? 20 + Math.random() * 60 : 0,
    };
  }

  private spawnStreak(w: number, h: number): Streak {
    const life = 1.2 + Math.random() * 1.8;
    return { x: Math.random() * w, y: Math.random() * h, age: Math.random() * life, life };
  }

  private spawnDrop(w: number, h: number, anywhere: boolean): Drop {
    return {
      x: Math.random() * (w + 80) - 40,
      y: anywhere ? Math.random() * h : -20 - Math.random() * 60,
      speed: 520 + Math.random() * 380,
      len: 10 + Math.random() * 14,
    };
  }
}
