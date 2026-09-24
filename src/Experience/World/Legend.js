import * as THREE from "three";
import Experience from "../Experience";

/**
 * Two views of the same key: a canvas-textured plane in the scene (as in
 * seals) and the HTML key in the 2D panel. Both redraw when the colour
 * mode changes between movement state and continuous speed.
 */
export default class Legend {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;

    this.canvas = document.createElement("canvas");
    this.canvas.width = 600;
    this.canvas.height = 300;
    this.ctx = this.canvas.getContext("2d");

    this.setupLegend();
    this.setupHTMLKey();
    this.redraw();
  }

  setupLegend() {
    // Create texture from canvas
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;

    // Create plane geometry and material
    const geometry = new THREE.PlaneGeometry(2, 1);
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      side: THREE.DoubleSide,
    });

    // Create mesh and add to scene: just off the east edge of the terrain,
    // facing back towards the map (as in seals).
    const topobath = this.experience.world.topobath;
    const edgeX = (topobath?.planeWorldWidth ?? 60) / 2 + 3;
    this.plane = new THREE.Mesh(geometry, material);
    this.plane.position.set(edgeX, 3, -8);
    this.plane.scale.set(2, 2, 2);
    this.plane.rotation.y = -90 * (Math.PI / 180);
    this.scene.add(this.plane);
  }

  setupHTMLKey() {
    this.keyElement = document.getElementById("key");
    const select = document.getElementById("color-mode");
    if (select) {
      select.value = this.experience.colorMode;
      select.addEventListener("change", () => {
        this.experience.colorMode = select.value;
        this.experience.world.lionPaths?.forEach((p) => p.updateColors());
        this.redraw();
      });
    }
  }

  speedGradientCSS() {
    const stops = this.experience.viridisStops
      .map((c, i, arr) => `#${c.getHexString()} ${(i / (arr.length - 1)) * 100}%`)
      .join(", ");
    return `linear-gradient(90deg, ${stops})`;
  }

  redraw() {
    this.drawCanvas();
    this.texture.needsUpdate = true;
    this.drawHTMLKey();
  }

  drawHTMLKey() {
    if (!this.keyElement) return;
    const mode = this.experience.colorMode;
    if (mode === "speed") {
      const max = this.experience.speedColorMax;
      this.keyElement.innerHTML = `
        <div class="key-bar" style="background:${this.speedGradientCSS()}"></div>
        <div class="key-ticks"><span>0</span><span>${(max / 2).toFixed(1)}</span><span>${max}+ km/h</span></div>
        <div class="panel-hint" style="margin-top:4px">Speed between consecutive fixes; dark = resting.</div>`;
      return;
    }
    this.keyElement.innerHTML =
      this.experience.legendItems
        .map(
          (item) =>
            `<div class="key-row"><span class="key-swatch" style="background:${item.color}"></span><span>${item.label}</span></div>`
        )
        .join("") +
      `<div class="panel-hint" style="margin-top:4px">State from GPS step length between fixes.</div>`;
  }

  drawCanvas() {
    const canvas = this.canvas;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw background
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw border
    ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
    ctx.lineWidth = 2;
    ctx.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);

    // Draw title
    ctx.fillStyle = "#333";
    ctx.font = "bold 40px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const speedMode = this.experience.colorMode === "speed";
    ctx.fillText(speedMode ? "Speed (km/h)" : "Movement State", canvas.width / 2, 45);

    if (speedMode) {
      const barX = 40;
      const barY = 110;
      const barW = canvas.width - 80;
      const barH = 50;
      const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      this.experience.viridisStops.forEach((c, i, arr) =>
        grad.addColorStop(i / (arr.length - 1), `#${c.getHexString()}`)
      );
      ctx.fillStyle = grad;
      ctx.fillRect(barX, barY, barW, barH);
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.strokeRect(barX, barY, barW, barH);
      ctx.fillStyle = "#333";
      ctx.font = "28px Arial";
      ctx.textBaseline = "top";
      const max = this.experience.speedColorMax;
      ctx.textAlign = "left";
      ctx.fillText("0", barX, barY + barH + 10);
      ctx.textAlign = "center";
      ctx.fillText((max / 2).toFixed(1), barX + barW / 2, barY + barH + 10);
      ctx.textAlign = "right";
      ctx.fillText(`${max}+`, barX + barW, barY + barH + 10);
      ctx.textAlign = "center";
      ctx.font = "24px Arial";
      ctx.fillText("speed between consecutive fixes", canvas.width / 2, barY + barH + 55);
      return;
    }

    // Draw legend items
    const legendItems = this.experience.legendItems;
    const boxSize = 25;
    const startY = 80;
    const rowHeight = 42;
    const boxX = 30;
    const textX = boxX + boxSize + 20;

    legendItems.forEach((item, index) => {
      const y = startY + index * rowHeight;

      // Draw colored box
      ctx.fillStyle = item.color;
      ctx.fillRect(boxX, y, boxSize, boxSize);

      // Draw box border
      ctx.strokeStyle = "rgba(0, 0, 0, 0.2)";
      ctx.lineWidth = 1;
      ctx.strokeRect(boxX, y, boxSize, boxSize);

      // Draw label text
      ctx.fillStyle = "#333";
      ctx.font = "28px Arial";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(item.label, textX, y + boxSize / 2);
    });
  }
}
