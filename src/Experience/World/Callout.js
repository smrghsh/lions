import * as THREE from "three";
import Experience from "../Experience";
import Lion from "./Lion.js";

export default class Callout extends THREE.Group {
  constructor() {
    super();
    this.experience = new Experience();
    this.scene = this.experience.scene;

    this.debug = this.experience.debug;

    this.debugFolder = this.debug.ui.addFolder("Callout");

    // Parameterized dimensions
    this.stemHeight = 0.18;
    this.displayWidth = 0.28; // Compact 3-column layout
    this.displayHeight = 0.12; // Compact height

    // Data properties with defaults (one GPS fix)
    this.lat = 0;
    this.lng = 0;
    this.elevation = 0;
    this.seconds = 0;
    this.rTime = "";
    this.step = 0;
    this.interval = 0;
    this.speed = 0;
    this.heading = 0;
    this.pitch = 0;
    this.state = 0;
    this.animalId = "";
    this.sex = "";
    this.dataset = "";

    // Add rTime display controller
    this.debugFolder.add(this, "rTime").name("Current Time").listen();
    this.debugFolder.add(this, "copyTime").name("Copy Time to Clipboard");
    // Navigation tracking
    this.currentLionPath = null;
    this.currentPointIndex = 0;

    // Puma marker for orientation representation (heading + track pitch)
    this.orientationRepresentation = new Lion();
    this.orientationRepresentation.scale.set(0.05, 0.05, 0.05);
    this.add(this.orientationRepresentation);

    // Enhanced glass stem with taper (thinner at top, slightly thicker at bottom)
    const stemGeometry = new THREE.CylinderGeometry(
      0.0015, // Top radius - thinner
      0.003, // Bottom radius - slightly thicker
      this.stemHeight,
      8 // Optimized segment count
    );

    // VR-optimized glass material (MeshBasicMaterial instead of MeshPhysicalMaterial)
    const stemMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });

    this.stem = new THREE.Mesh(stemGeometry, stemMaterial);
    this.stem.position.y = this.stemHeight / 2;
    this.add(this.stem);

    // Add subtle outer glow cylinder for rim lighting effect
    const glowGeometry = new THREE.CylinderGeometry(
      0.002,
      0.0035,
      this.stemHeight,
      8
    );
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide,
    });
    const glowStem = new THREE.Mesh(glowGeometry, glowMaterial);
    glowStem.position.y = this.stemHeight / 2;
    this.add(glowStem);

    // Create canvas once and reuse it (performance optimization)
    this.canvas = document.createElement("canvas");
    this.canvas.width = 800;
    this.canvas.height = 180;
    this.ctx = this.canvas.getContext("2d", {
      alpha: true,
      willReadFrequently: true,
    });

    // Draw initial glass background
    this.drawGlassBackground();

    const texture = new THREE.CanvasTexture(this.canvas);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false, // Prevent clipping through geometry
      depthWrite: false, // Don't write to depth buffer
    });
    this.informationDisplay = new THREE.Mesh(
      new THREE.PlaneGeometry(this.displayWidth, this.displayHeight),
      material
    );

    // Set high render order to ensure it renders on top
    this.informationDisplay.renderOrder = 999;

    // Position bottom edge of display at top of stem
    this.informationDisplay.position.y =
      this.stemHeight + this.displayHeight / 2;
    this.add(this.informationDisplay);

    this.scene.add(this);

    // Initially hide callout until clicked
    this.visible = false;
  }

  /**
   * Refresh the panel from one fix. `data` is the object LionPath.pointData
   * returns (lat, lng, elevation, rTime, step, interval, speed, heading,
   * pitch, state, animalId, sex, dataset).
   */
  updateInformationDisplay(data = {}) {
    // Store parameters as instance properties
    this.lat = data.lat ?? 0;
    this.lng = data.lng ?? 0;
    this.elevation = data.elevation ?? 0;
    this.seconds = data.seconds ?? 0;
    this.rTime = data.rTime ?? "";
    this.step = data.step ?? 0;
    this.interval = data.interval ?? 0;
    this.speed = data.speed ?? 0;
    this.heading = data.heading ?? 0;
    this.pitch = data.pitch ?? 0;
    this.state = data.state ?? 0;
    this.animalId = data.animalId ?? "";
    this.sex = data.sex ?? "";
    this.dataset = data.dataset ?? "";

    // Point the puma along the track: heading is a compass bearing
    // (clockwise from north) and the marker faces -z, so yaw = -heading;
    // pitch tilts the nose up the slope towards the next fix.
    this.orientationRepresentation.rotation.set(0, 0, 0);
    this.orientationRepresentation.rotateY(-1 * this.heading);
    this.orientationRepresentation.rotateX(this.pitch);

    // Reuse existing canvas and context
    const canvas = this.canvas;
    const ctx = this.ctx;

    // Clear and redraw background
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.drawGlassBackground();

    // Reset shadow for text rendering
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;

    // Convert radians to degrees
    const headingDeg = this.heading * (180 / Math.PI);
    const pitchDeg = this.pitch * (180 / Math.PI);

    const stateLabel =
      this.experience.movementStateLabels[this.state] || `State ${this.state}`;

    // Use system font stack for best rendering
    ctx.font =
      "600 18px -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

    // Add subtle text shadow for better readability on glass
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;

    // Use slightly darker white for better contrast
    ctx.fillStyle = "#f5f5f7";

    const centerX = canvas.width / 2;
    const col1X = 180;
    const col2X = 480;
    const lineHeight = 32;

    // Top center: animal + time
    ctx.textAlign = "center";
    let y = 35;
    const sexLabel = this.sex === "M" ? "male" : this.sex === "F" ? "female" : "";
    ctx.fillText(
      `Puma ${this.animalId} ${sexLabel ? `(${sexLabel})` : ""}  ·  ${
        this.rTime || "N/A"
      }`,
      centerX,
      y
    );

    // Below that: elevation from the terrain
    ctx.fillText(
      `Elevation: ${this.elevation.toFixed(0)} m`,
      centerX,
      (y += lineHeight)
    );

    // Two columns below
    ctx.textAlign = "left";
    y += lineHeight + 5; // Add a bit of spacing before columns

    // Left column: Heading, Pitch, Interval
    let leftY = y;
    ctx.fillText(`Heading: ${headingDeg.toFixed(1)}°`, col1X, leftY);
    ctx.fillText(
      `Slope: ${pitchDeg.toFixed(1)}°`,
      col1X,
      (leftY += lineHeight)
    );
    ctx.fillText(
      `Fix interval: ${this.formatInterval(this.interval)}`,
      col1X,
      (leftY += lineHeight)
    );

    // Right column: Speed, Step, State
    let rightY = y;
    ctx.fillText(`Speed: ${this.speed.toFixed(2)} km/h`, col2X, rightY);
    ctx.fillText(
      `Step: ${this.step.toFixed(0)} m`,
      col2X,
      (rightY += lineHeight)
    );
    const restMap = this.experience.world.restMap;
    const restText = restMap
      ? `  ·  rest p ${restMap.probabilityAt(this.lat, this.lng).toFixed(2)}`
      : "";
    ctx.fillText(`State: ${stateLabel}${restText}`, col2X, (rightY += lineHeight));

    // Update existing texture instead of creating new one
    this.informationDisplay.material.map.needsUpdate = true;
  }

  formatInterval(seconds) {
    if (!seconds) return "—";
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    const h = seconds / 3600;
    return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
  }

  // Helper method to draw glass background (cached for performance)
  drawGlassBackground() {
    const ctx = this.ctx;
    const canvas = this.canvas;
    const radius = 20;

    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, radius);
    ctx.fillStyle = "rgba(128, 128, 128, 0.6)";
    ctx.fill();

    // Add glass border effect
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Add subtle inner shadow for depth
    ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
  }

  // Navigate to next point in the lion path
  advancePoint() {
    if (!this.currentLionPath || !this.currentLionPath.points) return;

    this.currentPointIndex++;
    if (this.currentPointIndex >= this.currentLionPath.points.length) {
      this.currentPointIndex = this.currentLionPath.points.length - 1;
      return; // At end
    }

    this.updateFromPointIndex();
  }

  // Navigate to previous point in the lion path
  decrementPoint() {
    if (!this.currentLionPath || !this.currentLionPath.points) return;

    this.currentPointIndex--;
    if (this.currentPointIndex < 0) {
      this.currentPointIndex = 0;
      return; // At start
    }

    this.updateFromPointIndex();
  }

  // Update callout from current point index
  updateFromPointIndex() {
    if (!this.currentLionPath) return;

    const idx = this.currentPointIndex;
    const lionPath = this.currentLionPath;
    const data = lionPath.pointData(idx);

    // Update position
    this.position.copy(data.position);

    // Update data display
    this.updateInformationDisplay(data);

    // Update graphs asynchronously
    if (this.experience.world.graphs) {
      setTimeout(() => {
        this.experience.world.graphs.updateGraphs(lionPath, idx);
      }, 0);
    }

    // Send callout update to server if networking is available
    if (this.experience.networking) {
      this.experience.networking.sendCalloutUpdate(
        true,
        this.position,
        lionPath.name,
        idx
      );
    }
  }

  // Set the lion path and point index for navigation
  setLionPath(lionPath, pointIndex) {
    this.currentLionPath = lionPath;
    this.currentPointIndex = pointIndex;
  }

  // brahma's Networking.receiveCalloutUpdate still speaks seal
  setSealPath(path, pointIndex) {
    this.setLionPath(path, pointIndex);
  }

  copyTime() {
    // copy rTime to clipboard
    navigator.clipboard.writeText(this.rTime).then(() => {
      console.log("rTime copied to clipboard:", this.rTime);
    });
  }
}
