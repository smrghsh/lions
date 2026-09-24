import * as THREE from "three";
import Experience from "../Experience";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "./LineMaterial.js";
import SelectablePath from "./SelectablePath.js";
import FixVoxels from "./FixVoxels.js";

/**
 * One GPS collar dataset (e.g. "164M-5min-A") drawn as a fat line draped
 * over the terrain, plus a clickable voxel at every fix. Mirrors seals'
 * SealPath: parse the rows, keep typed arrays for every field so the
 * callout/graphs can index by point, and wrap the Line2 in a selectable
 * Path so the pointer can pick it.
 */
export default class LionPath {
  constructor(name, lionData) {
    this.experience = new Experience();
    this.name = name; // dataset chunk name, also used for networking
    this.dataset = name.replace(/-[A-Z]$/, ""); // "164M-5min-A" -> "164M-5min"
    this.ready = lionData.then((data) => {
      const topobath = this.experience.world.topobath;

      const isValid = (entry) =>
        isFinite(entry.Lat) &&
        isFinite(entry.Long) &&
        topobath.isInBounds(entry.Lat, entry.Long);

      // First pass: count valid entries
      let validCount = 0;
      data.forEach((entry) => {
        if (isValid(entry)) validCount++;
      });

      if (validCount === 0) {
        console.warn(`No valid points for ${name}.`);
        return;
      }
      // Pre-allocate arrays with exact size
      const points = new Array(validCount);
      const latitudes = new Float32Array(validCount);
      const longitudes = new Float32Array(validCount);
      const elevations = new Float32Array(validCount);
      const secondsArray = new Uint32Array(validCount);
      const rTimeArray = new Array(validCount);
      const steps = new Float32Array(validCount);
      const intervals = new Uint32Array(validCount);
      const speeds = new Float32Array(validCount);
      const headings = new Float32Array(validCount);
      const states = new Uint8Array(validCount);

      // Second pass: populate arrays. Every fix is dropped onto the
      // rendered terrain by Topobath.placeOnTerrain, lifted a few metres so
      // the line never z-fights with the surface.
      const lift = this.experience.pathLiftMeters;
      let idx = 0;
      data.forEach((entry) => {
        if (!isValid(entry)) return;

        points[idx] = topobath.placeOnTerrain(entry.Lat, entry.Long, lift);
        latitudes[idx] = entry.Lat;
        longitudes[idx] = entry.Long;
        elevations[idx] = topobath.elevationAt(entry.Lat, entry.Long);
        secondsArray[idx] = entry.Seconds || 0;
        rTimeArray[idx] = entry.R_Time || "";
        steps[idx] = entry.Step_m || 0;
        intervals[idx] = entry.Interval_s || 0;
        speeds[idx] = entry.Speed_kmh || 0;
        headings[idx] = entry.Heading || 0;
        states[idx] = entry.State_Num || 0;
        idx++;
      });

      const first = data.find(isValid);
      this.animalId = first.Animal_ID || "";
      this.sex = first.Sex || "";

      // keep world-space points for ray checks
      this.points = points;
      this.latitudes = latitudes;
      this.longitudes = longitudes;
      this.elevations = elevations;
      this.secondsArray = secondsArray;
      this.rTimeArray = rTimeArray;
      this.steps = steps;
      this.intervals = intervals;
      this.speeds = speeds;
      this.headings = headings;
      this.states = states;

      // Build LineGeometry for fat-line rendering, draped over the terrain
      const { positions, colors } = this.buildDrapedLine();
      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      geometry.setColors(colors);

      // Base color coding (fallback if colors not used)
      this.color = new THREE.Color(0x0000ff);
      if (name.includes("5min")) {
        this.color = new THREE.Color("Gold");
      } else if (name.includes("4hr")) {
        this.color = new THREE.Color("DeepSkyBlue");
      }
      const material = new LineMaterial({
        linewidth: name.includes("5min") ? 3 : 2, // Line thickness in pixels
        dashed: false,
        vertexColors: true, // Enable vertex colors for state / speed visualization
      });

      // Store material reference for resolution updates
      this.material = material;

      // Set initial resolution
      this.updateResolution();

      // Add resize listener for window size changes
      this.resizeHandler = () => this.updateResolution();
      window.addEventListener("resize", this.resizeHandler);

      // Handle VR session changes if WebXR is available
      if (this.experience.renderer?.xr) {
        this.xrSessionStartHandler = () => this.updateResolution();
        this.xrSessionEndHandler = () => this.updateResolution();
        this.experience.renderer.xr.addEventListener(
          "sessionstart",
          this.xrSessionStartHandler
        );
        this.experience.renderer.xr.addEventListener(
          "sessionend",
          this.xrSessionEndHandler
        );
      }

      this.path = new SelectablePath(geometry, material, name);
      this.path.lionPath = this; // Store reference to parent LionPath
      this.experience.world.scene.add(this.path);

      // A clickable cube on every fix
      this.voxels = new FixVoxels(this);
      this.experience.world.scene.add(this.voxels);

      return this;
    });
  }

  /**
   * Subdivide every hop between consecutive fixes every `drapeStepMeters`
   * of ground and drop each sub-point onto the terrain, so the line follows
   * ridges and valleys instead of tunnelling through them. Each hop is
   * coloured by the state/speed of the fix it arrives at (State_Num and
   * Speed_kmh describe the step *into* a fix).
   */
  buildDrapedLine() {
    const topobath = this.experience.world.topobath;
    const lift = this.experience.pathLiftMeters;
    const stepMeters = this.experience.drapeStepMeters;
    const positions = [];
    const colors = [];
    const color = new THREE.Color();
    const n = this.points.length;

    // first fix
    const p0 = this.points[0];
    positions.push(p0.x, p0.y, p0.z);
    this.experience.fixColor(this.states[0], this.speeds[0], color);
    colors.push(color.r, color.g, color.b);

    for (let i = 1; i < n; i++) {
      const subdivisions = Math.min(
        Math.max(Math.ceil(this.steps[i] / stepMeters), 1),
        400
      );
      this.experience.fixColor(this.states[i], this.speeds[i], color);
      const lat0 = this.latitudes[i - 1];
      const lng0 = this.longitudes[i - 1];
      const lat1 = this.latitudes[i];
      const lng1 = this.longitudes[i];
      for (let k = 1; k <= subdivisions; k++) {
        const t = k / subdivisions;
        let p;
        if (k === subdivisions) {
          p = this.points[i]; // land exactly on the fix
        } else {
          p = topobath.placeOnTerrain(
            lat0 + (lat1 - lat0) * t,
            lng0 + (lng1 - lng0) * t,
            lift
          );
        }
        positions.push(p.x, p.y, p.z);
        colors.push(color.r, color.g, color.b);
      }
    }
    return { positions, colors };
  }

  updateResolution() {
    if (!this.material) return;

    const renderer = this.experience.renderer;
    const canvas = renderer?.domElement;

    if (canvas) {
      // Get actual canvas size (works for VR and regular rendering)
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      this.material.resolution.set(width, height);
    } else {
      // Fallback to window size
      this.material.resolution.set(window.innerWidth, window.innerHeight);
    }
  }

  /**
   * Re-drop every point onto the terrain (after the vertical exaggeration
   * changes). Horizontal placement is unaffected.
   */
  updatePositions() {
    if (!this.points || !this.path) return;
    const topobath = this.experience.world.topobath;
    const lift = this.experience.pathLiftMeters;
    for (let i = 0; i < this.points.length; i++) {
      this.points[i].y = (this.elevations[i] + lift) * topobath.heightScalar;
    }
    const { positions } = this.buildDrapedLine();
    this.path.line.geometry.setPositions(positions);
    this.path.line.computeLineDistances();
    this.voxels?.updatePositions();
  }

  /** Recolour the line and voxels under the current colour mode. */
  updateColors() {
    if (!this.points || !this.path) return;
    const { colors } = this.buildDrapedLine();
    this.path.line.geometry.setColors(colors);
    this.voxels?.updateColors();
  }

  setVisible(value) {
    if (this.path) this.path.visible = value;
    if (this.voxels) {
      this.voxels.visible =
        value && this.experience.world.voxelsVisible !== false;
    }
  }

  findNearestPoint(position) {
    if (!this.points || this.points.length === 0) {
      return null;
    }

    let minDistance = Infinity;
    let nearestIndex = 0;

    // Optimized search with early exit and distanceToSquared (faster than distanceTo)
    for (let i = 0; i < this.points.length; i++) {
      const distSq = position.distanceToSquared(this.points[i]);
      if (distSq < minDistance) {
        minDistance = distSq;
        nearestIndex = i;

        // Early exit if we're very close (within 1cm squared)
        if (distSq < 0.0001) break;
      }
    }

    return this.pointData(nearestIndex);
  }

  /** Metadata bundle for one fix; what the callout and graphs consume. */
  pointData(index) {
    const i = Math.min(Math.max(index, 0), this.points.length - 1);
    // pitch of the track leaving this fix: rise over run to the next fix
    let pitch = 0;
    if (i + 1 < this.points.length && this.steps[i + 1] > 0) {
      pitch = Math.atan2(
        this.elevations[i + 1] - this.elevations[i],
        this.steps[i + 1]
      );
    }
    return {
      index: i,
      position: this.points[i],
      lat: this.latitudes[i],
      lng: this.longitudes[i],
      elevation: this.elevations[i],
      seconds: this.secondsArray[i],
      rTime: this.rTimeArray[i],
      step: this.steps[i],
      interval: this.intervals[i],
      speed: this.speeds[i],
      heading: this.headings[i],
      pitch,
      state: this.states[i],
      animalId: this.animalId,
      sex: this.sex,
      dataset: this.dataset,
    };
  }

  dispose() {
    // Clean up event listeners
    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
    }

    if (this.experience.renderer?.xr) {
      if (this.xrSessionStartHandler) {
        this.experience.renderer.xr.removeEventListener(
          "sessionstart",
          this.xrSessionStartHandler
        );
      }
      if (this.xrSessionEndHandler) {
        this.experience.renderer.xr.removeEventListener(
          "sessionend",
          this.xrSessionEndHandler
        );
      }
    }

    // Clean up geometry and material
    if (this.path) {
      if (this.path.geometry) this.path.geometry.dispose();
      if (this.material) this.material.dispose();
      if (this.path.parent) this.path.parent.remove(this.path);
    }
    if (this.voxels) {
      this.voxels.geometry.dispose();
      this.voxels.material.dispose();
      if (this.voxels.parent) this.voxels.parent.remove(this.voxels);
    }
  }
}
