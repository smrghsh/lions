import * as THREE from "three";
import { Environment } from "../brahma/Brahma.js";
import Experience from "../Experience.js";
import Topobath, { HOMERANGE_PATCH } from "./Topobath.js";
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
      // Resources hid the overlay; keep it up until the terrain, the
      // detail patch, the tracks and the rest map are all in.
      this.experience.setLoading("loading terrain tiles…", 0);
      this.topobath = new Topobath();
      // z14 terrain + z15 imagery nested over the 5 min home range
      this.topobath.addPatch(HOMERANGE_PATCH);
      // tile progress fills the first 70 % of the bar
      const tileTotal =
        (this.topobath.numCols * this.topobath.numRows +
          HOMERANGE_PATCH.numCols * HOMERANGE_PATCH.numRows) *
        2;
      let tilesDone = 0;
      const onTile = () => {
        tilesDone++;
        this.experience.setLoading(
          `loading terrain tiles… ${tilesDone} / ${tileTotal}`,
          (0.7 * tilesDone) / tileTotal
        );
      };
      this.topobath.onTileProgress = onTile;
      this.topobath.patches.forEach((p) => (p.onTileProgress = onTile));
      this.topobath.ready.then(() => {
        console.log("topobath promise resolved");
        this.experience.setLoading("placing tracks on the terrain…", 0.8);
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

    // Which datasets start visible: the 5 min home-range track is the
    // story, the 4 hr track is a toggle.
    this.datasetVisibility = { "164M-4hr": false, "164M-5min": true };
    this.focusDataset = "164M-5min";

    // Rest-site probability surface needs every track parsed first
    Promise.all(this.lionPaths.map((p) => p.ready)).then(() => {
      this.experience.setLoading("computing rest-site probability…", 0.92);
      // let the overlay repaint before the KDE blocks the main thread
      setTimeout(() => {
        this.restMap = new RestMap(this.lionPaths);
        this.frameDataset(this.focusDataset);
        this.experience.setLoading("ready", 1);
        this.experience.hideLoading();
      }, 30);
    });

    // Add debug controls (lil-gui) and panel checkboxes for dataset visibility
    for (const dataset of Object.keys(this.byDataset)) {
      if (this.datasetVisibility[dataset] === undefined) {
        this.datasetVisibility[dataset] = true;
      }
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
        box.checked = this.datasetVisibility[dataset];
        box.addEventListener("change", () => setVisible(box.checked));
      }
    }

    document.getElementById("reset-view")?.addEventListener("click", () => {
      this.frameDataset(this.focusDataset);
    });

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
   * Aim the desktop camera (and the XR start pose) at one dataset's
   * bounding box so the page opens zoomed into the home range.
   */
  frameDataset(dataset) {
    const paths = (this.byDataset[dataset] || []).filter((p) => p.points);
    if (paths.length === 0) return;
    const box = new THREE.Box3();
    for (const lionPath of paths) {
      for (const p of lionPath.points) box.expandByPoint(p);
    }
    this.experience.frameBox(box);
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
