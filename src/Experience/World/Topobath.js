import * as THREE from "three";
import Experience from "../Experience";
import bathyVertexShader from "../../shaders/bathy/vertex.glsl";
import bathyFragmentShader from "../../shaders/bathy/fragment.glsl";

/**
 * Topobath — a Web Mercator tile grid of the Santa Cruz Mountains, displaced
 * by real elevation and draped with imagery. Same shape as the seals repo's
 * Topobath (stitched tile canvases -> PlaneGeometry -> ShaderMaterial), with
 * these differences:
 *
 *   - the height layer is AWS/Mapzen "terrarium" PNG tiles, decoded on the
 *     CPU into a Float32 heightmap and handed to the vertex shader as a
 *     per-vertex attribute, so JS and GPU agree exactly on the surface;
 *   - `elevationAt(lat, lng)` / `placeOnTerrain(lat, lng)` return the
 *     height of the *rendered* mesh at any lat/lng (interpolated over the
 *     same triangles the GPU draws);
 *   - world scale is defined in metres (1 world unit = metersPerUnit) with
 *     a live vertical exaggeration slider;
 *   - finer tile grids can be nested as *patches* (`addPatch`): a hole is
 *     cut in the base mesh under the patch, the patch's rim is blended onto
 *     the base surface so the seam is watertight, and elevation lookups
 *     inside the hole come from the patch.
 *
 * Tile grids must match fetch_bathy.py.
 */

// z12 grid, 8 x 8 tiles around (37.09, -122.00)
export const BASE_GRID = {
  name: "base",
  zoom: 12,
  originTileX: 655,
  originTileY: 1589,
  numCols: 8,
  numRows: 8,
  terrainDir: "./tiles/terrain",
  colorDir: "./tiles/usgs",
  colorExt: "png",
  noaaDir: "./tiles/noaa",
  segmentsPerTile: 64, // -> 512 x 512 grid, ~120 m per segment
};

// z14 grid over puma 164M's 5 minute home range (fetch_bathy.py PATCHES)
export const HOMERANGE_PATCH = {
  name: "homerange",
  zoom: 14,
  originTileX: 2632,
  originTileY: 6366,
  numCols: 10,
  numRows: 9,
  terrainDir: "./tiles/terrain14",
  colorDir: "./tiles/usgs14",
  colorExt: "jpg",
  segmentsPerTile: 64, // -> ~30 m per segment, terrarium at ~7.6 m/px
};

export default class Topobath {
  constructor(config = BASE_GRID, parent = null) {
    this.experience = new Experience();
    this.scene = this.experience.scene;
    this.debug = this.experience.debug;
    this.config = config;
    this.parent = parent;
    this.patches = [];

    // --- tile grid ---
    this.zoom = config.zoom;
    this.originTileX = config.originTileX;
    this.originTileY = config.originTileY;
    this.numCols = config.numCols;
    this.numRows = config.numRows;
    this.tileSizeColor = 512; // NOAA / USGS pixels per tile
    this.tileSizeHeight = 256; // terrarium pixels per tile
    this.minValidElevation = -3500; // metres; anything lower is a tile artefact
    // Phones and standalone headsets get half the mesh density and
    // half-size drape textures (Experience.lowPower).
    this.lowPower = this.experience.lowPower;
    this.segmentsPerTile = this.lowPower
      ? Math.max(8, config.segmentsPerTile / 2)
      : config.segmentsPerTile;
    this.colorStitchSize = this.lowPower ? 256 : 512;
    this.gridPixelWidth = this.numCols * this.tileSizeColor;
    this.gridPixelHeight = this.numRows * this.tileSizeColor;

    if (parent) {
      // Patches share the parent's scale, layers and debug folder
      this.metersPerUnit = parent.metersPerUnit;
      this.layers = parent.layers;
      this.debugFolder = parent.debugFolder;
      // world footprint from the parent's projection of our tile bounds
      const west = this.tileXToLng(this.originTileX);
      const east = this.tileXToLng(this.originTileX + this.numCols);
      const north = this.tileYToLat(this.originTileY);
      const south = this.tileYToLat(this.originTileY + this.numRows);
      const [x0, , z0] = parent.projection(north, west, 0, true);
      const [x1, , z1] = parent.projection(south, east, 0, true);
      this.planeWorldWidth = x1 - x0;
      this.planeWorldHeight = z1 - z0;
      this.planeCenter = new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
      // our rect in the parent's colour-pixel space (for uv remapping and the hole)
      const tl = parent.latLngToGridPixel(north, west);
      const br = parent.latLngToGridPixel(south, east);
      this.rectInParent = { x0: tl.px, y0: tl.py, x1: br.px, y1: br.py };
      return;
    }

    this.debugFolder = this.debug.ui.addFolder("Topobath");

    // --- world scale ---
    this.metersPerUnit = 1000; // 1 world unit = 1 km on the ground
    this.verticalExaggeration = 2.0; // live slider
    this.seaTint = 0.65;
    this.hillshade = 0.7; // 0 = flat imagery, 1 = full relief shading
    this.ambient = 0.62; // floor of the relief shading (0.45 was quite dark)
    this.brightness = 1.2; // overall drape gain
    // Drape layers, each a checkbox in the 2D panel (index.html #panel)
    this.layers = {
      satellite: true, // USGS NAIP imagery
      hillshade: false, // NOAA topo-bathy colour hillshade
      relief: true, // slope-based shading in the shader
      contours: false, // 100 m contour lines
      sea: true, // tint below sea level
      rest: true, // rest-site probability overlay (RestMap)
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

    this.planeWorldWidth = this.gridPixelWidth / this.XZScalar;
    this.planeWorldHeight = this.gridPixelHeight / this.XZScalar;
    this.planeCenter = new THREE.Vector3(0, 0, 0);

    this.restMapTexture = this.emptyRestMap();
    this.ready = this.loadBathy().then(() => {
      this.setupDebug();
      this.setupLayerPanel();
    });
  }

  /**
   * Nest a finer tile grid inside this one. Chains onto `ready`, so call
   * it before awaiting `ready`.
   */
  addPatch(config) {
    const patch = new Topobath(config, this);
    patch.onTileProgress = this.onTileProgress;
    this.patches.push(patch);
    this.ready = this.ready
      .then(() => patch.loadBathy())
      .then(() => {
        this.cutHole(patch);
        patch.blendRimOntoParent();
        patch.buildMesh();
        console.log(
          `patch '${config.name}': z${config.zoom}, ${patch.segX}x${patch.segY} grid`
        );
      });
    return patch;
  }

  // ---------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------

  async loadBathy() {
    const c = this.config;
    const tilesTerrain = [];
    const tilesColor = [];
    const tilesNoaa = [];
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

    const total = this.numCols * this.numRows * 2;
    let loaded = 0;
    const tick = () => {
      loaded++;
      this.onTileProgress?.(loaded, total);
    };
    for (let x = this.originTileX; x < this.originTileX + this.numCols; x++) {
      let j = 0;
      tilesTerrain[i] = [];
      tilesColor[i] = [];
      tilesNoaa[i] = [];
      for (let y = this.originTileY; y < this.originTileY + this.numRows; y++) {
        const ii = i;
        const jj = j;
        promises.push(
          loadNumericImage(`${c.terrainDir}/Terrarium-${x}-${y}.png`).then((img) => {
            tilesTerrain[ii][jj] = img;
            tick();
          }),
          loadImage(`${c.colorDir}/USGS-${x}-${y}.${c.colorExt}`).then((img) => {
            tilesColor[ii][jj] = img;
            tick();
          })
        );
        j++;
      }
      i++;
    }

    await Promise.all(promises);
    console.log(`all tiles loaded (${c.name})`);

    // --- stitch each layer onto its own canvas at native tile size ---
    const stitch = (tiles, tileSize) => {
      const canvas = document.createElement("canvas");
      canvas.width = this.numCols * tileSize;
      canvas.height = this.numRows * tileSize;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      for (let col = 0; col < this.numCols; col++) {
        for (let row = 0; row < this.numRows; row++) {
          ctx.drawImage(
            tiles[col][row],
            col * tileSize,
            row * tileSize,
            tileSize,
            tileSize
          );
        }
      }
      return canvas;
    };

    const canvasTerrain = stitch(tilesTerrain, this.tileSizeHeight);
    this.canvasUsgs = stitch(tilesColor, this.colorStitchSize); // RestMap reads it
    this.decodeHeights(canvasTerrain);
    this.loadImage = loadImage;
    this.stitch = stitch;

    // --- colour textures (NOAA is fetched lazily by ensureNoaa) ---
    this.textureUsgs = this.makeTexture(this.canvasUsgs);
    this.textureNoaa = this.parent ? this.parent.textureNoaa : this.emptyRestMap();

    if (!this.parent) {
      this.buildHeightGrid();
      this.buildMesh();
    }
  }

  makeTexture(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.lowPower ? 2 : 8;
    t.needsUpdate = true;
    return t;
  }

  /**
   * The NOAA hillshade drape is 21 MB of tiles most viewers never switch
   * on, so it is only fetched the first time its checkbox is ticked.
   */
  ensureNoaa() {
    if (this.parent) return this.parent.ensureNoaa();
    if (this.noaaPromise) return this.noaaPromise;
    const c = this.config;
    const tiles = [];
    const promises = [];
    let i = 0;
    for (let x = this.originTileX; x < this.originTileX + this.numCols; x++) {
      let j = 0;
      tiles[i] = [];
      for (let y = this.originTileY; y < this.originTileY + this.numRows; y++) {
        const ii = i;
        const jj = j;
        promises.push(
          this.loadImage(`${c.noaaDir}/NOAA-${x}-${y}.png`).then((img) => {
            tiles[ii][jj] = img;
          })
        );
        j++;
      }
      i++;
    }
    this.noaaPromise = Promise.all(promises).then(() => {
      this.textureNoaa = this.makeTexture(this.stitch(tiles, this.colorStitchSize));
      for (const t of [this, ...this.patches]) {
        t.textureNoaa = this.textureNoaa;
        if (t.material) t.material.uniforms.uTextureNoaa.value = this.textureNoaa;
      }
      console.log("NOAA hillshade loaded");
    });
    return this.noaaPromise;
  }

  /** Terrarium RGB -> metres, once, on the CPU, then despike. */
  decodeHeights(canvasTerrain) {
    this.heightmapWidth = canvasTerrain.width;
    this.heightmapHeight = canvasTerrain.height;
    const pixels = canvasTerrain
      .getContext("2d")
      .getImageData(0, 0, this.heightmapWidth, this.heightmapHeight).data;
    const n = this.heightmapWidth * this.heightmapHeight;
    this.heightmap = new Float32Array(n);
    let maxH = -Infinity;
    for (let p = 0; p < n; p++) {
      const r = pixels[p * 4];
      const g = pixels[p * 4 + 1];
      const b = pixels[p * 4 + 2];
      const h = r * 256 + g + b / 256 - 32768;
      this.heightmap[p] = h;
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
    let minH = Infinity;
    for (let p = 0; p < n; p++) if (hm[p] < minH) minH = hm[p];
    this.minElevation = minH;
    this.maxElevation = maxH;
    console.log(
      `terrain decoded (${this.config.name}): ${W}x${H}, ` +
        `${minH.toFixed(0)} m to ${maxH.toFixed(0)} m` +
        (filled ? `, ${filled} nodata pixels filled` : "")
    );
  }

  /**
   * Sample the heightmap at every mesh vertex. PlaneGeometry lays vertices
   * out row by row from the top-left (uv v=1) so vertex (i, j) is at
   * u = i/segX, v = 1 - j/segY, i.e. heightmap pixel (i/segX*W, j/segY*H).
   */
  buildHeightGrid() {
    this.segX = this.numCols * this.segmentsPerTile;
    this.segY = this.numRows * this.segmentsPerTile;
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
  }

  /**
   * Patch only: rebuild the height grid so vertices outside the parent's
   * hole take the parent's surface height, and vertices within one parent
   * cell inside the hole blend from parent to fine data. The patch then
   * meets the parent's rim exactly (parent.elevationAtOwn interpolates the
   * parent's own triangles), so the seam is watertight.
   */
  blendRimOntoParent() {
    this.buildHeightGrid();
    const parent = this.parent;
    const hole = parent.holeRects[parent.holeRects.length - 1];
    const cellPx = parent.gridPixelWidth / parent.segX;
    const gridW = this.segX + 1;
    const gridH = this.segY + 1;
    const smooth = (t) => t * t * (3 - 2 * t);
    const r = this.rectInParent;
    for (let j = 0; j < gridH; j++) {
      for (let i = 0; i < gridW; i++) {
        // this vertex in the parent's pixel space
        const px = r.x0 + (i / this.segX) * (r.x1 - r.x0);
        const py = r.y0 + (j / this.segY) * (r.y1 - r.y0);
        const d = Math.min(px - hole.x0, hole.x1 - px, py - hole.y0, hole.y1 - py);
        const t = Math.min(Math.max(d / cellPx, 0), 1); // 0 = at/outside hole edge
        if (t >= 1) continue;
        const { lat, lng } = parent.gridPixelToLatLng(px, py);
        const coarse = parent.elevationAtOwn(lat, lng);
        const k = j * gridW + i;
        this.heightGrid[k] = coarse * (1 - smooth(t)) + this.heightGrid[k] * smooth(t);
      }
    }
  }

  /** Geometry + material for this grid; base builds once, patches after blending. */
  buildMesh() {
    const root = this.parent || this;
    const geometry = new THREE.PlaneGeometry(
      this.planeWorldWidth,
      this.planeWorldHeight,
      this.segX,
      this.segY
    );
    const gridW = this.segX + 1;
    const gridH = this.segY + 1;
    geometry.setAttribute("aHeight", new THREE.BufferAttribute(this.heightGrid, 1));

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

    // uv remap so a patch samples the parent's NOAA / rest-map textures
    let baseUvOffset = new THREE.Vector2(0, 0);
    let baseUvScale = new THREE.Vector2(1, 1);
    if (this.parent) {
      const r = this.rectInParent;
      const W = this.parent.gridPixelWidth;
      const H = this.parent.gridPixelHeight;
      baseUvOffset = new THREE.Vector2(r.x0 / W, 1 - r.y1 / H);
      baseUvScale = new THREE.Vector2((r.x1 - r.x0) / W, (r.y1 - r.y0) / H);
    }

    const L = root.layers;
    this.material = new THREE.ShaderMaterial({
      vertexShader: bathyVertexShader,
      fragmentShader: bathyFragmentShader,
      uniforms: {
        uTextureUsgs: { value: this.textureUsgs },
        uTextureNoaa: { value: this.textureNoaa },
        uRestMap: { value: root.restMapTexture },
        uBaseUvOffset: { value: baseUvOffset },
        uBaseUvScale: { value: baseUvScale },
        uSatellite: { value: L.satellite ? 1 : 0 },
        uHillshadeLayer: { value: L.hillshade ? 1 : 0 },
        uContours: { value: L.contours ? 1 : 0 },
        uRestLayer: { value: L.rest ? 1 : 0 },
        uHeightScalar: { value: root.heightScalar },
        uExaggeration: { value: root.verticalExaggeration },
        uSeaTint: { value: L.sea ? root.seaTint : 0 },
        uHillshade: { value: L.relief ? root.hillshade : 0 },
        uAmbient: { value: root.ambient },
        uBrightness: { value: root.brightness },
        // afternoon sun from the south-west (world x east, y up, z south)
        uSun: { value: new THREE.Vector3(-0.5, 0.75, 0.45).normalize() },
      },
    });

    this.plane = new THREE.Mesh(geometry, this.material);
    this.plane.rotation.x = -Math.PI / 2;
    this.plane.position.copy(this.planeCenter);
    this.plane.name = `topobath-${this.config.name}`;
    this.scene.add(this.plane);
  }

  /**
   * Drop every base cell that lies fully inside the patch so the two
   * meshes never overlap; the patch's blended rim covers the remainder.
   */
  cutHole(patch) {
    const cellPx = this.gridPixelWidth / this.segX;
    const r = patch.rectInParent;
    const ci0 = Math.ceil(r.x0 / cellPx);
    const ci1 = Math.floor(r.x1 / cellPx); // exclusive cell bound
    const cj0 = Math.ceil(r.y0 / cellPx);
    const cj1 = Math.floor(r.y1 / cellPx);
    const hole = { x0: ci0 * cellPx, x1: ci1 * cellPx, y0: cj0 * cellPx, y1: cj1 * cellPx };
    this.holeRects = this.holeRects || [];
    this.holeRects.push(hole);

    const geometry = this.plane.geometry;
    const index = geometry.getIndex().array;
    const kept = [];
    for (let cj = 0; cj < this.segY; cj++) {
      for (let ci = 0; ci < this.segX; ci++) {
        if (ci >= ci0 && ci < ci1 && cj >= cj0 && cj < cj1) continue;
        const base = (cj * this.segX + ci) * 6;
        for (let k = 0; k < 6; k++) kept.push(index[base + k]);
      }
    }
    geometry.setIndex(kept);
  }

  emptyRestMap() {
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  }

  /** Every material this Topobath owns (itself plus patches). */
  allMaterials() {
    return [this, ...this.patches].map((t) => t.material).filter(Boolean);
  }

  /** RestMap hands its density texture here once the tracks are loaded. */
  setRestMap(texture) {
    this.restMapTexture = texture;
    for (const m of this.allMaterials()) m.uniforms.uRestMap.value = texture;
  }

  /** Push this.layers and the lighting constants into every shader. */
  applyLayers() {
    const L = this.layers;
    for (const m of this.allMaterials()) {
      const u = m.uniforms;
      u.uSatellite.value = L.satellite ? 1 : 0;
      u.uHillshadeLayer.value = L.hillshade ? 1 : 0;
      u.uContours.value = L.contours ? 1 : 0;
      u.uRestLayer.value = L.rest ? 1 : 0;
      u.uSeaTint.value = L.sea ? this.seaTint : 0;
      u.uHillshade.value = L.relief ? this.hillshade : 0;
      u.uAmbient.value = this.ambient;
      u.uBrightness.value = this.brightness;
    }
  }

  /** Wire the checkboxes in index.html's #panel to this.layers. */
  setupLayerPanel() {
    for (const key of Object.keys(this.layers)) {
      const box = document.getElementById(`layer-${key}`);
      if (!box) continue;
      box.checked = this.layers[key];
      box.addEventListener("change", () => {
        this.layers[key] = box.checked;
        if (key === "hillshade" && box.checked) this.ensureNoaa();
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
        for (const m of this.allMaterials()) {
          m.uniforms.uHeightScalar.value = this.heightScalar;
          m.uniforms.uExaggeration.value = this.verticalExaggeration;
        }
        // Tracks and the callout are placed in world units, so re-project
        // them onto the new surface.
        const world = this.experience.world;
        world.lionPaths?.forEach((lionPath) => lionPath.updatePositions());
        if (world.callout?.visible) world.callout.updateFromPointIndex();
      });
    this.debugFolder
      .add(this, "brightness", 0.5, 2, 0.05)
      .name("Brightness")
      .onChange(() => this.applyLayers());
    this.debugFolder
      .add(this, "ambient", 0.2, 1, 0.02)
      .name("Ambient (shade floor)")
      .onChange(() => this.applyLayers());
    this.debugFolder
      .add(this, "hillshade", 0, 1, 0.05)
      .name("Relief strength")
      .onChange(() => this.applyLayers());
    this.debugFolder
      .add(this, "seaTint", 0, 1, 0.05)
      .name("Sea tint strength")
      .onChange(() => this.applyLayers());
    const view = { wireframe: false, terrain: true, patches: true };
    this.debugFolder
      .add(view, "wireframe")
      .name("Wireframe")
      .onChange((v) => this.allMaterials().forEach((m) => (m.wireframe = v)));
    this.debugFolder
      .add(view, "terrain")
      .name("Show terrain")
      .onChange((v) => (this.plane.visible = v));
    this.debugFolder
      .add(view, "patches")
      .name("Show detail patches")
      .onChange((v) => this.patches.forEach((p) => p.plane && (p.plane.visible = v)));
  }

  // ---------------------------------------------------------------------
  // Coordinate helpers
  // ---------------------------------------------------------------------

  tileYToLat(y) {
    const n = Math.pow(2, this.zoom);
    return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  }

  tileXToLng(x) {
    return (x / Math.pow(2, this.zoom)) * 360 - 180;
  }

  /** lat/lng -> colour-pixel coordinates relative to this grid's top-left. */
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

  /** Inverse of latLngToGridPixel. */
  gridPixelToLatLng(px, py) {
    const scale = Math.pow(2, this.zoom);
    const worldCoordX = px / this.tileSizeColor + this.originTileX;
    const worldCoordY = py / this.tileSizeColor + this.originTileY;
    const lng = (worldCoordX / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * worldCoordY) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lng };
  }

  isInBounds(lat, lng) {
    const { px, py } = this.latLngToGridPixel(lat, lng);
    return px >= 0 && py >= 0 && px <= this.gridPixelWidth && py <= this.gridPixelHeight;
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

  /** The loaded patch whose hole contains the point, if any. */
  patchAt(lat, lng) {
    if (!this.holeRects) return null;
    const { px, py } = this.latLngToGridPixel(lat, lng);
    for (let i = 0; i < this.patches.length; i++) {
      const h = this.holeRects[i];
      const p = this.patches[i];
      if (h && p.heightGrid && px >= h.x0 && px <= h.x1 && py >= h.y0 && py <= h.y1) {
        return p;
      }
    }
    return null;
  }

  /**
   * Elevation (metres) of the rendered mesh at a lat/lng: the patch's
   * surface inside a hole, otherwise this grid's own surface.
   */
  elevationAt(lat, lng) {
    const patch = this.patchAt(lat, lng);
    return patch ? patch.elevationAtOwn(lat, lng) : this.elevationAtOwn(lat, lng);
  }

  /**
   * Elevation of *this* grid's mesh only. Interpolates over the same two
   * triangles per cell that PlaneGeometry indexes ((a,b,d) and (b,c,d)),
   * so the result lies exactly on the drawn surface. 0 before load.
   */
  elevationAtOwn(lat, lng) {
    if (!this.heightGrid) return 0;
    const { px, py } = this.latLngToGridPixel(lat, lng);
    const gridW = this.segX + 1;
    const gx = Math.min(Math.max((px / this.gridPixelWidth) * this.segX, 0), this.segX - 1e-6);
    const gy = Math.min(Math.max((py / this.gridPixelHeight) * this.segY, 0), this.segY - 1e-6);
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
   * Patches delegate the horizontal part to the base grid.
   */
  projection(lat, lng, liftMeters = 0, xzOnly = false) {
    if (this.parent) return this.parent.projection(lat, lng, liftMeters, xzOnly);
    const { px, py } = this.latLngToGridPixel(lat, lng);
    const x = px / this.XZScalar - this.planeWorldWidth / 2;
    const z = py / this.XZScalar - this.planeWorldHeight / 2;
    const y = xzOnly ? 0 : (this.elevationAt(lat, lng) + liftMeters) * this.heightScalar;
    return [x, y, z];
  }

  /** Same as projection() but returns a Vector3 — "put this lat/lng on the ground". */
  placeOnTerrain(lat, lng, liftMeters = 0) {
    const [x, y, z] = this.projection(lat, lng, liftMeters);
    return new THREE.Vector3(x, y, z);
  }

  // Convert world Y back to elevation in metres
  worldYToElevation(worldY) {
    return worldY / (this.parent || this).heightScalar;
  }

  // Convert world X/Z back to lat/lng (inverse of projection's horizontal part)
  worldToLatLng(x, z) {
    const root = this.parent || this;
    const px = (x + root.planeWorldWidth / 2) * root.XZScalar;
    const py = (z + root.planeWorldHeight / 2) * root.XZScalar;
    return root.gridPixelToLatLng(px, py);
  }

  scaling() {
    console.log("scaling");
  }
}
