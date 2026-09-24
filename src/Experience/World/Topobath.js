import * as THREE from "three";
import Experience from "../Experience";
import bathyVertexShader from "../../shaders/bathy/vertex.glsl";
import bathyFragmentShader from "../../shaders/bathy/fragment.glsl";

/**
 * Topobath — a Web Mercator tile grid of the Santa Cruz Mountains, displaced
 * by real elevation and draped with imagery. Same shape as the seals repo's
 * Topobath (stitched tile canvases -> PlaneGeometry -> ShaderMaterial), with
 * three differences:
 *
 *   - the height layer is AWS/Mapzen "terrarium" PNG tiles, decoded on the
 *     CPU into a Float32 heightmap and handed to the vertex shader as a
 *     per-vertex attribute, so JS and GPU agree exactly on the surface;
 *   - `elevationAt(lat, lng)` / `placeOnTerrain(lat, lng)` return the
 *     height of the *rendered* mesh at any lat/lng (interpolated over the
 *     same triangles the GPU draws);
 *   - world scale is defined in metres (1 world unit = metersPerUnit) with
 *     a live vertical exaggeration slider.
 *
 * The tile grid must match fetch_bathy.py.
 */
export default class Topobath {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;
    this.debug = this.experience.debug;
    this.debugFolder = this.debug.ui.addFolder("Topobath");

    // --- tile grid (see fetch_bathy.py: ORIGIN, TILE_ZOOM, DX/DY ranges) ---
    this.zoom = 12;
    this.initialTileX = 659; // tile containing (37.09, -122.00)
    this.initialTileY = 1593;
    this.tileRangeX = [-4, 3];
    this.tileRangeY = [-4, 3];
    this.originTileX = this.initialTileX + this.tileRangeX[0]; // 655
    this.originTileY = this.initialTileY + this.tileRangeY[0]; // 1589
    this.numCols = this.tileRangeX[1] - this.tileRangeX[0] + 1; // 8
    this.numRows = this.tileRangeY[1] - this.tileRangeY[0] + 1; // 8
    this.tileSizeColor = 512; // NOAA / USGS pixels per tile
    this.tileSizeHeight = 256; // terrarium pixels per tile
    this.minValidElevation = -3500; // metres; anything lower is a tile artefact

    // --- world scale ---
    this.metersPerUnit = 1000; // 1 world unit = 1 km on the ground
    this.verticalExaggeration = 2.0; // live slider
    this.segmentsPerTile = 64; // mesh resolution (64 -> 512x512 grid)
    this.seaTint = 0.65;
    this.hillshade = 0.7; // 0 = flat imagery, 1 = full relief shading
    // Drape layers, each a checkbox in the 2D panel (index.html #panel)
    this.layers = {
      satellite: true, // USGS NAIP imagery
      hillshade: false, // NOAA topo-bathy colour hillshade
      relief: true, // slope-based shading in the shader
      contours: false, // 100 m contour lines
      sea: true, // tint below sea level
      rest: false, // rest-site probability overlay (RestMap)
    };

    // Mercator ground resolution at the grid's centre latitude, in metres
    // per colour pixel (156543.03 m/px at z0 for 256 px tiles).
    const centerLat = this.tileYToLat(this.originTileY + this.numRows / 2);
    this.metersPerColorPixel =
      ((156543.03392 * Math.cos((centerLat * Math.PI) / 180)) /
        Math.pow(2, this.zoom)) *
      (256 / this.tileSizeColor);

    // colour pixels per world unit (seals' XZScalar, now derived)
    this.XZScalar = this.metersPerUnit / this.metersPerColorPixel;
    this.heightScalar = this.verticalExaggeration / this.metersPerUnit;

    this.gridPixelWidth = this.numCols * this.tileSizeColor;
    this.gridPixelHeight = this.numRows * this.tileSizeColor;
    this.planeWorldWidth = this.gridPixelWidth / this.XZScalar;
    this.planeWorldHeight = this.gridPixelHeight / this.XZScalar;

    this.ready = this.loadBathy();
  }

  async loadBathy() {
    const tilesTerrain = [];
    const tilesNoaa = [];
    const tilesUsgs = [];
    const promises = [];
    let i = 0;

    const loadImage = (url) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`failed to load ${url}`));
        img.src = url;
      });

    // Terrarium PNGs carry packed numbers, not colours: decode them without
    // colour management or premultiplication (caye's fetchGeo pattern —
    // visionOS Safari otherwise nudges channel values and spikes the mesh).
    // Also guard against vite's SPA fallback answering a missing tile with
    // index.html + HTTP 200.
    const loadNumericImage = async (url) => {
      const r = await fetch(url);
      const type = r.headers.get("content-type") || "";
      if (!r.ok || !type.startsWith("image/")) {
        throw new Error(`bad terrain tile ${url}: ${r.status} ${type}`);
      }
      return createImageBitmap(await r.blob(), {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
    };

    for (let x = this.originTileX; x < this.originTileX + this.numCols; x++) {
      let j = 0;
      tilesTerrain[i] = [];
      tilesNoaa[i] = [];
      tilesUsgs[i] = [];
      for (let y = this.originTileY; y < this.originTileY + this.numRows; y++) {
        const ii = i;
        const jj = j;
        promises.push(
          loadNumericImage(`./tiles/terrain/Terrarium-${x}-${y}.png`).then((img) => {
            tilesTerrain[ii][jj] = img;
          }),
          loadImage(`./tiles/noaa/NOAA-${x}-${y}.png`).then((img) => {
            tilesNoaa[ii][jj] = img;
          }),
          loadImage(`./tiles/usgs/USGS-${x}-${y}.png`).then((img) => {
            tilesUsgs[ii][jj] = img;
          })
        );
        j++;
      }
      i++;
    }

    await Promise.all(promises);
    console.log("all tiles loaded");

    // --- stitch each layer onto its own canvas at native tile size ---
    const stitch = (tiles, tileSize) => {
      const canvas = document.createElement("canvas");
      canvas.width = this.numCols * tileSize;
      canvas.height = this.numRows * tileSize;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      for (let col = 0; col < this.numCols; col++) {
        for (let row = 0; row < this.numRows; row++) {
          ctx.drawImage(tiles[col][row], col * tileSize, row * tileSize);
        }
      }
      return canvas;
    };

    const canvasTerrain = stitch(tilesTerrain, this.tileSizeHeight);
    const canvasNoaa = stitch(tilesNoaa, this.tileSizeColor);
    const canvasUsgs = stitch(tilesUsgs, this.tileSizeColor);

    // --- decode terrarium RGB -> metres, once, on the CPU ---
    this.heightmapWidth = canvasTerrain.width;
    this.heightmapHeight = canvasTerrain.height;
    const pixels = canvasTerrain
      .getContext("2d")
      .getImageData(0, 0, this.heightmapWidth, this.heightmapHeight).data;
    const n = this.heightmapWidth * this.heightmapHeight;
    this.heightmap = new Float32Array(n);
    let minH = Infinity;
    let maxH = -Infinity;
    for (let p = 0; p < n; p++) {
      const r = pixels[p * 4];
      const g = pixels[p * 4 + 1];
      const b = pixels[p * 4 + 2];
      const h = r * 256 + g + b / 256 - 32768;
      this.heightmap[p] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    // Despike: the Terrarium ocean tiles carry a few stray pixels far
    // below anything real here (Monterey Canyon bottoms out around
    // -3300 m in this grid). Treat them as nodata and fill from neighbours.
    const W = this.heightmapWidth;
    const H = this.heightmapHeight;
    const hm = this.heightmap;
    let filled = 0;
    for (let pass = 0; pass < 4; pass++) {
      let remaining = 0;
      for (let p = 0; p < n; p++) {
        if (hm[p] >= this.minValidElevation) continue;
        const x = p % W;
        const y = (p - x) / W;
        let sum = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const v = hm[yy * W + xx];
            if (v >= this.minValidElevation) {
              sum += v;
              c++;
            }
          }
        }
        if (c > 0) {
          hm[p] = sum / c;
          filled++;
        } else {
          remaining++;
        }
      }
      if (remaining === 0) break;
    }
    if (filled) {
      console.log(`terrain despiked: ${filled} nodata pixels filled`);
      minH = Infinity;
      for (let p = 0; p < n; p++) if (hm[p] < minH) minH = hm[p];
    }
    this.minElevation = minH;
    this.maxElevation = maxH;
    console.log(
      `terrain decoded: ${this.heightmapWidth}x${this.heightmapHeight}, ` +
        `${minH.toFixed(0)} m to ${maxH.toFixed(0)} m`
    );

    // --- colour textures (runtime switchable) ---
    const textureNoaa = new THREE.CanvasTexture(canvasNoaa);
    const textureUsgs = new THREE.CanvasTexture(canvasUsgs);
    for (const t of [textureNoaa, textureUsgs]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      t.needsUpdate = true;
    }
    this.textureNoaa = textureNoaa;
    this.textureUsgs = textureUsgs;
    this.canvasUsgs = canvasUsgs; // RestMap derives its vegetation proxy from it

    // --- geometry: one vertex grid over the whole tile mosaic ---
    this.segX = this.numCols * this.segmentsPerTile;
    this.segY = this.numRows * this.segmentsPerTile;
    const geometry = new THREE.PlaneGeometry(
      this.planeWorldWidth,
      this.planeWorldHeight,
      this.segX,
      this.segY
    );

    // Sample the heightmap at every vertex. PlaneGeometry lays vertices out
    // row by row from the top-left (uv v=1) so vertex (i, j) is at
    // u = i/segX, v = 1 - j/segY, i.e. heightmap pixel (i/segX*W, j/segY*H).
    const gridW = this.segX + 1;
    const gridH = this.segY + 1;
    this.heightGrid = new Float32Array(gridW * gridH);
    for (let j = 0; j < gridH; j++) {
      const py = (j / this.segY) * this.heightmapHeight;
      for (let i = 0; i < gridW; i++) {
        const px = (i / this.segX) * this.heightmapWidth;
        this.heightGrid[j * gridW + i] = this.sampleHeightmap(px, py);
      }
    }
    geometry.setAttribute(
      "aHeight",
      new THREE.BufferAttribute(this.heightGrid, 1)
    );

    // Central-difference slope (metres of rise per metre of run) at every
    // vertex, so the fragment shader can hillshade the drape for whatever
    // vertical exaggeration is dialled in (see drones' Terrain.js).
    const metersPerSegX = (this.planeWorldWidth * this.metersPerUnit) / this.segX;
    const metersPerSegY = (this.planeWorldHeight * this.metersPerUnit) / this.segY;
    const slope = new Float32Array(gridW * gridH * 2);
    for (let j = 0; j < gridH; j++) {
      for (let i = 0; i < gridW; i++) {
        const l = this.heightGrid[j * gridW + Math.max(i - 1, 0)];
        const r = this.heightGrid[j * gridW + Math.min(i + 1, gridW - 1)];
        const u = this.heightGrid[Math.max(j - 1, 0) * gridW + i];
        const d = this.heightGrid[Math.min(j + 1, gridH - 1) * gridW + i];
        const k = (j * gridW + i) * 2;
        slope[k] = (r - l) / (2 * metersPerSegX); // east
        slope[k + 1] = (d - u) / (2 * metersPerSegY); // south (world +z)
      }
    }
    geometry.setAttribute("aSlope", new THREE.BufferAttribute(slope, 2));

    const material = new THREE.ShaderMaterial({
      vertexShader: bathyVertexShader,
      fragmentShader: bathyFragmentShader,
      uniforms: {
        uTextureUsgs: { value: textureUsgs },
        uTextureNoaa: { value: textureNoaa },
        uRestMap: { value: this.emptyRestMap() },
        uSatellite: { value: this.layers.satellite ? 1 : 0 },
        uHillshadeLayer: { value: this.layers.hillshade ? 1 : 0 },
        uContours: { value: this.layers.contours ? 1 : 0 },
        uRestLayer: { value: this.layers.rest ? 1 : 0 },
        uHeightScalar: { value: this.heightScalar },
        uExaggeration: { value: this.verticalExaggeration },
        uSeaTint: { value: this.layers.sea ? this.seaTint : 0 },
        uHillshade: { value: this.layers.relief ? this.hillshade : 0 },
        // afternoon sun from the south-west (world x east, y up, z south)
        uSun: { value: new THREE.Vector3(-0.5, 0.75, 0.45).normalize() },
      },
    });
    this.material = material;

    this.plane = new THREE.Mesh(geometry, material);
    this.plane.rotation.x = -Math.PI / 2;
    this.plane.position.y = 0;
    this.plane.name = "topobath";
    this.scene.add(this.plane);

    this.setupDebug();
    this.setupLayerPanel();
  }

  emptyRestMap() {
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  }

  /** RestMap hands its density texture here once the tracks are loaded. */
  setRestMap(texture) {
    this.material.uniforms.uRestMap.value = texture;
  }

  /** Push this.layers into the shader uniforms. */
  applyLayers() {
    const u = this.material.uniforms;
    const L = this.layers;
    u.uSatellite.value = L.satellite ? 1 : 0;
    u.uHillshadeLayer.value = L.hillshade ? 1 : 0;
    u.uContours.value = L.contours ? 1 : 0;
    u.uRestLayer.value = L.rest ? 1 : 0;
    u.uSeaTint.value = L.sea ? this.seaTint : 0;
    u.uHillshade.value = L.relief ? this.hillshade : 0;
  }

  /** Wire the checkboxes in index.html's #panel to this.layers. */
  setupLayerPanel() {
    for (const key of Object.keys(this.layers)) {
      const box = document.getElementById(`layer-${key}`);
      if (!box) continue;
      box.checked = this.layers[key];
      box.addEventListener("change", () => {
        this.layers[key] = box.checked;
        this.applyLayers();
      });
    }
  }

  setupDebug() {
    this.debugFolder
      .add(this, "verticalExaggeration", 0.5, 6, 0.1)
      .name("Vertical exaggeration")
      .onChange(() => {
        this.heightScalar = this.verticalExaggeration / this.metersPerUnit;
        this.material.uniforms.uHeightScalar.value = this.heightScalar;
        this.material.uniforms.uExaggeration.value = this.verticalExaggeration;
        // Tracks and the callout are placed in world units, so re-project
        // them onto the new surface.
        const world = this.experience.world;
        world.lionPaths?.forEach((lionPath) => lionPath.updatePositions());
        if (world.callout?.visible) world.callout.updateFromPointIndex();
      });
    this.debugFolder
      .add(this, "seaTint", 0, 1, 0.05)
      .name("Sea tint strength")
      .onChange(() => this.applyLayers());
    this.debugFolder
      .add(this, "hillshade", 0, 1, 0.05)
      .name("Relief strength")
      .onChange(() => this.applyLayers());
    this.debugFolder.add(this.material, "wireframe").name("Wireframe");
    this.debugFolder.add(this.plane, "visible").name("Show terrain");
  }

  // ---------------------------------------------------------------------
  // Coordinate helpers
  // ---------------------------------------------------------------------

  tileYToLat(y) {
    const n = Math.pow(2, this.zoom);
    return (
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
    );
  }

  /** lat/lng -> colour-pixel coordinates relative to the grid's top-left. */
  latLngToGridPixel(lat, lng) {
    const scale = Math.pow(2, this.zoom);
    const worldCoordX = ((lng + 180) / 360) * scale;
    const latRad = (lat * Math.PI) / 180;
    const worldCoordY =
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      scale;
    return {
      px: (worldCoordX - this.originTileX) * this.tileSizeColor,
      py: (worldCoordY - this.originTileY) * this.tileSizeColor,
    };
  }

  isInBounds(lat, lng) {
    const { px, py } = this.latLngToGridPixel(lat, lng);
    return (
      px >= 0 && py >= 0 && px <= this.gridPixelWidth && py <= this.gridPixelHeight
    );
  }

  /** Bilinear sample of the decoded heightmap at pixel coords (px, py). */
  sampleHeightmap(px, py) {
    const W = this.heightmapWidth;
    const H = this.heightmapHeight;
    // pixel-centre convention: value at integer+0.5
    const sx = Math.min(Math.max(px - 0.5, 0), W - 1);
    const sy = Math.min(Math.max(py - 0.5, 0), H - 1);
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const x1 = Math.min(x0 + 1, W - 1);
    const y1 = Math.min(y0 + 1, H - 1);
    const fx = sx - x0;
    const fy = sy - y0;
    const hm = this.heightmap;
    const top = hm[y0 * W + x0] * (1 - fx) + hm[y0 * W + x1] * fx;
    const bottom = hm[y1 * W + x0] * (1 - fx) + hm[y1 * W + x1] * fx;
    return top * (1 - fy) + bottom * fy;
  }

  /**
   * Elevation (metres) of the rendered mesh at a lat/lng. Interpolates over
   * the same two triangles per cell that PlaneGeometry indexes
   * ((a,b,d) and (b,c,d)), so the result lies exactly on the drawn surface.
   * Returns 0 before the tiles have loaded.
   */
  elevationAt(lat, lng) {
    if (!this.heightGrid) return 0;
    const { px, py } = this.latLngToGridPixel(lat, lng);
    const gridW = this.segX + 1;
    const gx = Math.min(
      Math.max((px / this.gridPixelWidth) * this.segX, 0),
      this.segX - 1e-6
    );
    const gy = Math.min(
      Math.max((py / this.gridPixelHeight) * this.segY, 0),
      this.segY - 1e-6
    );
    const ci = Math.floor(gx);
    const cj = Math.floor(gy);
    const fx = gx - ci;
    const fy = gy - cj;
    const hg = this.heightGrid;
    const ha = hg[cj * gridW + ci]; // top-left
    const hb = hg[(cj + 1) * gridW + ci]; // bottom-left
    const hc = hg[(cj + 1) * gridW + ci + 1]; // bottom-right
    const hd = hg[cj * gridW + ci + 1]; // top-right
    if (fx + fy <= 1) {
      return ha + fx * (hd - ha) + fy * (hb - ha);
    }
    return hc + (1 - fx) * (hb - hc) + (1 - fy) * (hd - hc);
  }

  /**
   * lat/lng (+ optional metres above the ground) -> [x, y, z] world units,
   * with y on the rendered terrain. Mirrors seals' projection(lat, lng, depth).
   */
  projection(lat, lng, liftMeters = 0) {
    const { px, py } = this.latLngToGridPixel(lat, lng);
    const x = px / this.XZScalar - this.planeWorldWidth / 2;
    const z = py / this.XZScalar - this.planeWorldHeight / 2;
    const y = (this.elevationAt(lat, lng) + liftMeters) * this.heightScalar;
    return [x, y, z];
  }

  /** Same as projection() but returns a Vector3 — "put this lat/lng on the ground". */
  placeOnTerrain(lat, lng, liftMeters = 0) {
    const [x, y, z] = this.projection(lat, lng, liftMeters);
    return new THREE.Vector3(x, y, z);
  }

  // Convert world Y back to elevation in metres
  worldYToElevation(worldY) {
    return worldY / this.heightScalar;
  }

  // Convert world X/Z back to lat/lng (inverse of projection's horizontal part)
  worldToLatLng(x, z) {
    const px = (x + this.planeWorldWidth / 2) * this.XZScalar;
    const py = (z + this.planeWorldHeight / 2) * this.XZScalar;
    const scale = Math.pow(2, this.zoom);
    const worldCoordX = px / this.tileSizeColor + this.originTileX;
    const worldCoordY = py / this.tileSizeColor + this.originTileY;
    const lng = (worldCoordX / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * worldCoordY) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lng };
  }

  scaling() {
    console.log("scaling");
  }
}
