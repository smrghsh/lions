import * as THREE from "three";
import Experience from "../Experience.js";

/**
 * Rest-site probability surface: a time-weighted kernel density of the
 * fixes where 164M was resting (State_Num 1, i.e. under 0.05 km/h between
 * fixes), rasterised over the tile grid and handed to the terrain shader as
 * an overlay texture.
 *
 * Each resting fix splats a Gaussian (bandwidth `sigmaMeters`) weighted by
 * how long the collar sat there (the fix interval in hours), so a 4-hour
 * fix at a day bed counts for 48 five-minute fixes. The surface is scaled
 * so its maximum is 1: values are *relative* probabilities, not calibrated
 * ones.
 *
 * "In the forest": there is no land-cover layer in the data, so an optional
 * vegetation proxy from the USGS imagery (dark, green-dominant pixels)
 * down-weights open ground. It is a proxy, not a forest map.
 */
export default class RestMap {
  constructor(lionPaths) {
    this.experience = new Experience();
    this.topobath = this.experience.world.topobath;
    this.lionPaths = lionPaths;

    this.size = 512; // cells across the whole tile grid (~120 m each)
    this.sigmaMeters = 250;
    this.forestWeighting = true;
    this.restState = 1;

    this.forest = this.buildForestProxy();
    this.texture = new THREE.DataTexture(
      new Uint8Array(this.size * this.size * 4),
      this.size,
      this.size,
      THREE.RGBAFormat
    );
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.rebuild();
    this.topobath.setRestMap(this.texture);

    const folder = this.experience.debug.ui.addFolder("Rest sites");
    folder
      .add(this, "sigmaMeters", 100, 1000, 25)
      .name("Bandwidth (m)")
      .onFinishChange(() => this.rebuild());
    folder
      .add(this, "forestWeighting")
      .name("Vegetation weighting")
      .onChange(() => this.rebuild());
  }

  /** 0..1 per cell: how much the imagery looks like closed vegetation. */
  buildForestProxy() {
    const N = this.size;
    const src = this.topobath.canvasUsgs;
    const out = new Float32Array(N * N);
    if (!src) return out.fill(1);

    const canvas = document.createElement("canvas");
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, N, N);
    const d = ctx.getImageData(0, 0, N, N).data;
    const smooth = (e0, e1, x) => {
      const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
      return t * t * (3 - 2 * t);
    };
    for (let i = 0; i < N * N; i++) {
      const r = d[i * 4];
      const g = d[i * 4 + 1];
      const b = d[i * 4 + 2];
      const sum = r + g + b + 1;
      const greenness = g / sum - 1 / 3; // > 0 when green dominates
      const brightness = sum / 765;
      out[i] = smooth(0.015, 0.07, greenness) * smooth(0.7, 0.35, brightness);
    }
    // one 3x3 box blur so single pixels don't punch holes
    const blurred = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let s = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
            s += out[yy * N + xx];
            c++;
          }
        }
        blurred[y * N + x] = s / c;
      }
    }
    return blurred;
  }

  rebuild() {
    const N = this.size;
    const tb = this.topobath;
    const density = new Float32Array(N * N);
    const cellMeters = (tb.gridPixelWidth * tb.metersPerColorPixel) / N;
    const sigma = this.sigmaMeters / cellMeters; // in cells
    const radius = Math.ceil(sigma * 3);
    const inv2s2 = 1 / (2 * sigma * sigma);

    let restingFixes = 0;
    for (const lionPath of this.lionPaths) {
      if (!lionPath.points) continue;
      for (let i = 0; i < lionPath.points.length; i++) {
        if (lionPath.states[i] !== this.restState) continue;
        restingFixes++;
        const { px, py } = tb.latLngToGridPixel(
          lionPath.latitudes[i],
          lionPath.longitudes[i]
        );
        const cx = (px / tb.gridPixelWidth) * N;
        const cy = (py / tb.gridPixelHeight) * N;
        const weight = Math.max(lionPath.intervals[i], 60) / 3600; // hours
        const x0 = Math.max(Math.floor(cx - radius), 0);
        const x1 = Math.min(Math.ceil(cx + radius), N - 1);
        const y0 = Math.max(Math.floor(cy - radius), 0);
        const y1 = Math.min(Math.ceil(cy + radius), N - 1);
        for (let y = y0; y <= y1; y++) {
          const dy = y + 0.5 - cy;
          for (let x = x0; x <= x1; x++) {
            const dx = x + 0.5 - cx;
            density[y * N + x] += weight * Math.exp(-(dx * dx + dy * dy) * inv2s2);
          }
        }
      }
    }

    if (this.forestWeighting) {
      for (let i = 0; i < N * N; i++) {
        density[i] *= 0.15 + 0.85 * this.forest[i];
      }
    }

    let max = 0;
    for (let i = 0; i < N * N; i++) if (density[i] > max) max = density[i];

    // Write R = relative probability. Texture row 0 is the *bottom* (v = 0)
    // while grid row 0 is north (top), so flip while packing.
    const data = this.texture.image.data;
    for (let y = 0; y < N; y++) {
      const srcRow = N - 1 - y;
      for (let x = 0; x < N; x++) {
        const v = max > 0 ? density[srcRow * N + x] / max : 0;
        const k = (y * N + x) * 4;
        data[k] = Math.round(v * 255);
        data[k + 1] = 0;
        data[k + 2] = 0;
        data[k + 3] = 255;
      }
    }
    this.texture.needsUpdate = true;
    this.restingFixes = restingFixes;
    console.log(
      `rest map: ${restingFixes} resting fixes, sigma ${this.sigmaMeters} m, ` +
        `forest weighting ${this.forestWeighting ? "on" : "off"}`
    );
  }

  /** Relative rest probability (0..1) at a lat/lng, for the callout. */
  probabilityAt(lat, lng) {
    const tb = this.topobath;
    const N = this.size;
    const { px, py } = tb.latLngToGridPixel(lat, lng);
    const x = Math.min(Math.max(Math.floor((px / tb.gridPixelWidth) * N), 0), N - 1);
    const y = Math.min(Math.max(Math.floor((py / tb.gridPixelHeight) * N), 0), N - 1);
    const row = N - 1 - y;
    return this.texture.image.data[(row * N + x) * 4] / 255;
  }
}
