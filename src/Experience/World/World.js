import * as THREE from "three";
import { Environment } from "../brahma/Brahma.js";
import Experience from "../Experience.js";
import Topobath from "./Topobath.js";
import LionPath from "./LionPath.js";
import SeaLevelPlane from "./SeaLevelPlane.js";
import Sky from "./Sky.js";
import Papa from "papaparse";
import Legend from "./Legend.js";
import Graphs from "./Graphs.js";
import Callout from "./Callout.js";
import RestMap from "./RestMap.js";

export default class World {
  constructor() {
    this.experience = new Experience();
    this.sizes = this.experience.sizes;
    this.scene = this.experience.scene;
    this.resources = this.experience.resources;
    this.debug = this.experience.debug;
    this.debugFolder = this.debug.ui.addFolder("world");
    this.ready = false;
    // Wait for resources

    this.resources.on("ready", () => {
      this.topobath = new Topobath();
      this.topobath.ready.then(() => {
        console.log("topobath promise resolved");
        this.loadLionPaths();
      });
      this.environment = new Environment();
      this.seaLevelPlane = new SeaLevelPlane();
      this.skyBox = new Sky();
      this.legend = new Legend();
      this.graphs = new Graphs();
      this.callout = new Callout();
      this.callout.updateInformationDisplay({});
    });
    this.ready = true;
  }
  loadLionPaths() {
    // Array of all lion data files to load (chunk names from
    // Raw_Data_Processing_Scripts/processdata.py; also listed in sources.js)
    const lionDataArray = ["164M-4hr-A", "164M-5min-A"];

    // Store lion paths organized by dataset
    this.byDataset = {
      "164M-4hr": [],
      "164M-5min": [],
    };

    this.lionPaths = []; // Keep an array of all lion paths too
    // brahma's Networking looks paths up under this name
    this.sealPaths = this.lionPaths;
    this.voxelsVisible = true;

    for (const filename of lionDataArray) {
      const data = this.csvToJson(filename);
      const lionPath = new LionPath(filename, data);

      // Add to appropriate dataset array based on name
      const dataset = filename.replace(/-[A-Z]$/, "");
      if (!this.byDataset[dataset]) this.byDataset[dataset] = [];
      this.byDataset[dataset].push(lionPath);

      this.lionPaths.push(lionPath);
    }

    console.log(
      `Loaded lion paths: ` +
        Object.entries(this.byDataset)
          .map(([k, v]) => `${v.length} ${k}`)
          .join(", ")
    );

    // Rest-site probability surface needs every track parsed first
    Promise.all(this.lionPaths.map((p) => p.ready)).then(() => {
      this.restMap = new RestMap(this.lionPaths);
    });

    // Add debug controls (lil-gui) and panel checkboxes for dataset visibility
    this.datasetVisibility = {};
    for (const dataset of Object.keys(this.byDataset)) {
      this.datasetVisibility[dataset] = true;
      const setVisible = (value) => {
        this.datasetVisibility[dataset] = value;
        this.byDataset[dataset].forEach((lionPath) => lionPath.setVisible(value));
      };
      this.debugFolder
        .add(this.datasetVisibility, dataset)
        .name(`Show ${dataset}`)
        .listen()
        .onChange(setVisible);
      const box = document.getElementById(`track-${dataset}`);
      if (box) {
        box.checked = true;
        box.addEventListener("change", () => setVisible(box.checked));
      }
    }

    const setVoxels = (value) => {
      this.voxelsVisible = value;
      this.lionPaths.forEach((lionPath) =>
        lionPath.setVisible(this.datasetVisibility[lionPath.dataset] !== false)
      );
    };
    this.debugFolder
      .add(this, "voxelsVisible")
      .name("Show fix voxels")
      .listen()
      .onChange(setVoxels);
    const voxelBox = document.getElementById("layer-voxels");
    if (voxelBox) {
      voxelBox.checked = true;
      voxelBox.addEventListener("change", () => setVoxels(voxelBox.checked));
    }

    // Clicks on the panel shouldn't fall through to the pointer's select()
    document.getElementById("panel")?.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    // make it appropriate size please
    this.intersectionSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xff0000 })
    );
    this.intersectionSphere.visible = false;
    this.scene.add(this.intersectionSphere);
  }

  /**
   * Parse a CSV that Resources already fetched (sources.js lists every
   * chunk as "simulationData"), so the loading screen covers the data too.
   * Falls back to fetching if the name isn't in resources.
   */
  async csvToJson(name) {
    let csvText = this.resources.items[name];
    if (typeof csvText !== "string") {
      const response = await fetch(`./${name}.csv`);
      csvText = await response.text();
    }
    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
    });
    return parsed.data;
  }

  update() {
    if (this.ready) {
      this.lionPaths?.forEach((lionPath) => lionPath.voxels?.update());
    }
  }
}
