import * as THREE from "three";
import Experience from "../Experience.js";

// One table drives the in-world graph planes and the HTML overlays alike:
// which LionPath array to plot, the y range, and the colour.
const WINDOW = 200; // fixes drawn to the right of the callout's fix
const GRAPH_CONFIGS = [
  {
    key: "elevations",
    title: `Elevation (Next ${WINDOW} Fixes)`,
    shortTitle: "Elevation",
    yLabel: "Elevation (m)",
    unit: "m",
    yMin: 0,
    yMax: 1200,
    yStep: 200,
    color: "#7c3aed",
  },
  {
    key: "speeds",
    title: `Speed (Next ${WINDOW} Fixes)`,
    shortTitle: "Speed",
    yLabel: "Speed (km/h)",
    unit: "km/h",
    yMin: 0,
    yMax: 5,
    yStep: 1,
    color: "#dc2626",
  },
  {
    key: "steps",
    title: `Step Length (Next ${WINDOW} Fixes)`,
    shortTitle: "Step",
    yLabel: "Step (m)",
    unit: "m",
    yMin: 0,
    yMax: 3000,
    yStep: 500,
    color: "#16a34a",
  },
];

export default class Graphs extends THREE.Group {
  constructor() {
    super();
    this.experience = new Experience();
    this.scene = this.experience.scene;

    // Graph dimensions
    this.graphWidth = 6;
    this.graphHeight = 3;
    this.spacing = 0.6;

    // Beside the legend, off the east edge of the terrain
    const topobath = this.experience.world.topobath;
    const edgeX = (topobath?.planeWorldWidth ?? 60) / 2 + 3;
    this.position.set(edgeX, 10, -2);
    this.rotation.y = -90 * (Math.PI / 180);

    // Get HTML canvas elements
    this.htmlCanvases = [
      document.getElementById("graph-elevation"),
      document.getElementById("graph-speed"),
      document.getElementById("graph-step"),
    ];

    this.setupGraphs();
    this.scene.add(this);
  }

  setupGraphs() {
    // Create three graph planes
    this.graphs = [];

    for (let i = 0; i < GRAPH_CONFIGS.length; i++) {
      const canvas = this.createGraphCanvas(i);
      const texture = new THREE.CanvasTexture(canvas);
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;

      const geometry = new THREE.PlaneGeometry(
        this.graphWidth,
        this.graphHeight
      );
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
      });

      const plane = new THREE.Mesh(geometry, material);

      // Stack graphs vertically
      plane.position.y = -i * (this.graphHeight + this.spacing);

      this.graphs.push({
        plane: plane,
        canvas: canvas,
        texture: texture,
        ctx: canvas.getContext("2d"),
      });

      this.add(plane);
    }

    // Draw the empty HTML overlays too so the page doesn't show blank boxes
    this.htmlCanvases.forEach((c, i) => {
      if (c) this.drawHTMLGraphBase(c.getContext("2d"), c, i);
    });
  }

  createGraphCanvas(index) {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 600;
    const ctx = canvas.getContext("2d");
    this.drawGraphBase(ctx, canvas, index);
    return canvas;
  }

  updateGraphs(lionPath, startIndex) {
    if (!lionPath || startIndex === undefined) return;

    // Update each graph with the next WINDOW fixes
    this.graphs.forEach((graph, graphIndex) => {
      this.redrawGraph(graph, graphIndex, lionPath, startIndex);

      // Also update the HTML canvas
      if (this.htmlCanvases[graphIndex]) {
        this.redrawHTMLGraph(
          this.htmlCanvases[graphIndex],
          graphIndex,
          lionPath,
          startIndex
        );
      }
    });
  }

  redrawGraph(graph, graphIndex, lionPath, startIndex) {
    const canvas = graph.canvas;
    const ctx = graph.ctx;
    const config = GRAPH_CONFIGS[graphIndex];

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Redraw base graph (background, axes, labels)
    this.drawGraphBase(ctx, canvas, graphIndex);

    // Define plot area (must match drawGraphBase)
    const plotLeft = 100;
    const plotRight = canvas.width - 50;
    const plotTop = 90;
    const plotBottom = canvas.height - 80;
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;

    this.plotSeries(
      ctx,
      lionPath[config.key],
      startIndex,
      config,
      { plotLeft, plotBottom, plotWidth, plotHeight },
      2,
      5
    );

    // Update texture
    graph.texture.needsUpdate = true;
  }

  /** Shared line + current-point drawing for both canvas sizes. */
  plotSeries(ctx, dataArray, startIndex, config, area, lineWidth, dotRadius) {
    if (!dataArray) return;
    const { plotLeft, plotBottom, plotWidth, plotHeight } = area;
    const { yMin, yMax, color } = config;

    // Extract next WINDOW points (or fewer if at end)
    const endIndex = Math.min(startIndex + WINDOW, dataArray.length);
    const numPoints = endIndex - startIndex;

    if (numPoints < 2) return; // Need at least 2 points to draw

    const toY = (value) => {
      const normalized = Math.min(Math.max((value - yMin) / (yMax - yMin), 0), 1);
      return plotBottom - normalized * plotHeight;
    };

    // Draw line graph
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();

    let started = false;
    for (let i = 0; i < numPoints; i++) {
      const value = dataArray[startIndex + i];

      // Skip if invalid value
      if (value === undefined || value === null || isNaN(value)) continue;

      const x = plotLeft + (i / (WINDOW - 1)) * plotWidth;
      const y = toY(value);

      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();

    // Mark current position (first point) with a circle
    const value = dataArray[startIndex];
    if (value !== undefined && value !== null && !isNaN(value)) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(plotLeft, toY(value), dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawGraphBase(ctx, canvas, graphIndex) {
    const config = GRAPH_CONFIGS[graphIndex];

    // Draw background
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw border
    ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
    ctx.lineWidth = 3;
    ctx.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);

    // Draw title
    ctx.fillStyle = "#333";
    ctx.font = "bold 36px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(config.title, canvas.width / 2, 45);

    // Define plot area
    const plotLeft = 100;
    const plotRight = canvas.width - 50;
    const plotTop = 90;
    const plotBottom = canvas.height - 80;
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;

    // Draw axes
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotTop);
    ctx.lineTo(plotLeft, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = "#333";
    ctx.font = "20px Arial";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    const yRange = config.yMax - config.yMin;
    const numYTicks = Math.round(yRange / config.yStep);

    for (let i = 0; i <= numYTicks; i++) {
      const value = config.yMin + i * config.yStep;
      const y = plotBottom - (i / numYTicks) * plotHeight;

      // Draw tick mark
      ctx.beginPath();
      ctx.moveTo(plotLeft - 5, y);
      ctx.lineTo(plotLeft, y);
      ctx.stroke();

      // Draw label
      ctx.fillText(value.toString(), plotLeft - 10, y);

      // Draw grid line
      ctx.strokeStyle = "rgba(0, 0, 0, 0.1)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 2;
    }

    // X-axis labels (0 to WINDOW fixes)
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let i = 0; i <= 4; i++) {
      const value = (i * WINDOW) / 4;
      const x = plotLeft + (i / 4) * plotWidth;

      // Draw tick mark
      ctx.beginPath();
      ctx.moveTo(x, plotBottom);
      ctx.lineTo(x, plotBottom + 5);
      ctx.stroke();

      // Draw label
      ctx.fillText(value.toString(), x, plotBottom + 10);
    }

    // Y-axis label
    ctx.save();
    ctx.translate(30, canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = "bold 24px Arial";
    ctx.textAlign = "center";
    ctx.fillText(config.yLabel, 0, 0);
    ctx.restore();

    // X-axis label
    ctx.font = "bold 24px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Fix Index", canvas.width / 2, canvas.height - 20);
  }

  redrawHTMLGraph(htmlCanvas, graphIndex, lionPath, startIndex) {
    if (!htmlCanvas) return;

    const ctx = htmlCanvas.getContext("2d");
    const canvas = htmlCanvas;
    const config = GRAPH_CONFIGS[graphIndex];

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw base graph with smaller dimensions
    this.drawHTMLGraphBase(ctx, canvas, graphIndex);

    // Define plot area (must match drawHTMLGraphBase)
    const plotLeft = 28;
    const plotRight = canvas.width - 8;
    const plotTop = 18;
    const plotBottom = canvas.height - 15;
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;

    this.plotSeries(
      ctx,
      lionPath[config.key],
      startIndex,
      config,
      { plotLeft, plotBottom, plotWidth, plotHeight },
      1,
      2
    );
  }

  drawHTMLGraphBase(ctx, canvas, graphIndex) {
    const config = GRAPH_CONFIGS[graphIndex];

    // Draw background
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw title
    ctx.fillStyle = "#333";
    ctx.font = "bold 8px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(config.shortTitle, 5, 10);

    // Define plot area
    const plotLeft = 28;
    const plotRight = canvas.width - 8;
    const plotTop = 18;
    const plotBottom = canvas.height - 15;
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;

    // Draw axes
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotTop);
    ctx.lineTo(plotLeft, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.stroke();

    // Y-axis labels: only the ends and the middle at this size
    ctx.fillStyle = "#333";
    ctx.font = "6px Arial";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= 2; i++) {
      const value = config.yMin + ((config.yMax - config.yMin) * i) / 2;
      const y = plotBottom - (i / 2) * plotHeight;

      // Draw tick mark
      ctx.beginPath();
      ctx.moveTo(plotLeft - 2, y);
      ctx.lineTo(plotLeft, y);
      ctx.stroke();

      // Draw label
      ctx.fillText(value.toString(), plotLeft - 3, y);

      // Draw grid line
      ctx.strokeStyle = "rgba(0, 0, 0, 0.1)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 0.8;
    }

    // X-axis labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "5px Arial";

    for (let i = 0; i <= 2; i++) {
      const value = (i * WINDOW) / 2;
      const x = plotLeft + (i / 2) * plotWidth;

      // Draw tick mark
      ctx.beginPath();
      ctx.moveTo(x, plotBottom);
      ctx.lineTo(x, plotBottom + 2);
      ctx.stroke();

      // Draw label
      ctx.fillText(value.toString(), x, plotBottom + 3);
    }

    // Y-axis label
    ctx.font = "bold 6px Arial";
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(config.unit, plotLeft - 3, 13);
  }
}
