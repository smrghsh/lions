import * as THREE from "three";
import {
  Debug,
  Sizes,
  Time,
  Resources,
  Camera,
  Renderer,
  Networking,
  User,
  Controller,
} from "./brahma/Brahma.js";
import HandLocomotion from "./xr/HandLocomotion.js";
import EventEmitter from "./brahma/utilities/EventEmitter.js";
import Pointer from "./Utils/Pointer.js";
import World from "./World/World.js";
import sources from "./sources.js";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";

let instance = null;

export default class Experience extends EventEmitter {
  constructor(canvas) {
    super();

    // Singleton pattern
    if (instance) {
      return instance;
    }
    instance = this;
    window.experience = this;

    this.canvas = canvas;
    this.debug = new Debug();
    this.user = new User();
    /* Selectable Objects */
    this.selectableObjects = [];

    /**
     * Visualization Constants
     *
     * Movement states are derived from GPS step length between fixes
     * (see Raw_Data_Processing_Scripts/processdata.py). Index 0 is unused
     * so the array lines up with State_Num 1..5.
     */
    this.movementStateColors = [
      new THREE.Color(0x0000ff), // 0 invalid
      new THREE.Color(0x4c6ef5), // 1 Resting
      new THREE.Color(0x20c997), // 2 Local
      new THREE.Color(0xfab005), // 3 Traveling
      new THREE.Color(0xfd7e14), // 4 Fast
      new THREE.Color(0xe03131), // 5 Running
    ];
    this.movementStateLabels = {
      1: "Resting",
      2: "Local",
      3: "Traveling",
      4: "Fast",
      5: "Running",
    };
    this.legendItems = [
      { color: "#4C6EF5", label: "Resting  (< 0.05 km/h)" },
      { color: "#20C997", label: "Local  (0.05 – 0.5)" },
      { color: "#FAB005", label: "Traveling  (0.5 – 2)" },
      { color: "#FD7E14", label: "Fast  (2 – 5)" },
      { color: "#E03131", label: "Running  (> 5 km/h)" },
    ];

    // Track colouring: "state" (5 movement classes above) or "speed"
    // (continuous viridis ramp, 0 .. speedColorMax km/h).
    this.colorMode = "state";
    this.speedColorMax = 3;
    this.viridisStops = [
      new THREE.Color(0x440154),
      new THREE.Color(0x3b528b),
      new THREE.Color(0x21918c),
      new THREE.Color(0x5ec962),
      new THREE.Color(0xfde725),
    ];

    // How far (in metres, before exaggeration) tracks float above the
    // terrain so a fat line never z-fights with the surface it sits on.
    this.pathLiftMeters = 12;
    // Tracks are draped: each hop between fixes is subdivided every this
    // many metres and every sub-point dropped onto the terrain.
    this.drapeStepMeters = 60;
    // Clickable cube at every fix (metres on the ground, before exaggeration)
    this.voxelSizeMeters = 40;

    // Where the XR rig starts when a session begins (world units: 1 = 1 km,
    // y is exaggerated elevation). Above the ridges around 164M's range.
    this.xrStartPosition = new THREE.Vector3(0, 2.5, 4);

    /*
      Pointer Section
    */
    this.pointer = new Pointer();

    const sizes = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

    window.addEventListener("mousemove", (event) => {
      if (!this.camera) return; // Wait for camera to be initialized
      const mouse = new THREE.Vector2();
      mouse.x = (event.clientX / sizes.width) * 2 - 1;
      mouse.y = -(event.clientY / sizes.height) * 2 + 1;
      this.pointer.setSource("camera", { camera: this.camera.instance, mouse });
    });

    window.addEventListener("click", () => {
      this.pointer.select();
    });

    // Arrow key navigation for callout (similar to joystick scrubbing)
    this.arrowKeyLastScrubTime = 0;
    this.arrowKeyScrubDelay = 100; // Same throttle delay as joystick (100ms)

    window.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        const now = Date.now();
        if (now - this.arrowKeyLastScrubTime > this.arrowKeyScrubDelay) {
          if (event.key === "ArrowRight") {
            this.world?.callout?.advancePoint();
          } else if (event.key === "ArrowLeft") {
            this.world?.callout?.decrementPoint();
          }
          this.arrowKeyLastScrubTime = now;
        }
      }
    });

    if (this.debug.active) {
      this.debug.ui
        .add(
          {
            initNetworking: () => {
              window.experience.networking = new Networking();

              // hides Join Session after it's clicked
              this.debug.ui.domElement.style.display = "none";
            },
          },
          "initNetworking"
        )
        .name("Join Session");
    }

    this.sizes = new Sizes();
    this.time = new Time();
    this.scene = new THREE.Scene();
    this.resources = new Resources(sources);
    this.world = new World();
    this.cameraGroup = new THREE.Group();

    this.camera = new Camera();
    // brahma's Camera starts a few metres from the origin, which for a dive
    // site is fine but here is inside a mountain. Pull back for an overview
    // of the puma's home range; OrbitControls keep the rest.
    this.camera.instance.position.set(-9, 8, 16);
    this.camera.controls.target.set(0, 0.8, 0);
    this.camera.controls.update();

    this.renderer = new Renderer();

    // Initialize pointer with camera source now that camera exists
    const initialMouse = new THREE.Vector2(0, 0);
    this.pointer.setSource("camera", {
      camera: this.camera.instance,
      mouse: initialMouse,
    });
    console.log("Pointer initialized with camera source");

    /** XR/Immersive Code */
    this.scene.add(this.cameraGroup);
    this.controller = new Controller();
    // Teleport "floors" (bottom button on the pointer controller) cycle
    // between two hover heights above the range instead of seals' sea
    // level / -5 m dive floors.
    this.controller.locomotion.floors = [
      this.xrStartPosition.y,
      this.xrStartPosition.y + 3,
    ];
    // Hand-tracked locomotion (Vision Pro / Quest hands): its own input path,
    // reads XR hand joints only, never the controller gamepads.
    this.handLocomotion = new HandLocomotion();
    this.renderer.instance.xr.enabled = true;
    document.body.appendChild(
      VRButton.createButton(this.renderer.instance, {
        // optional: Quest with controllers behaves exactly as before; hands
        // only get joints on devices that grant it (Vision Pro, Quest w/o controllers)
        optionalFeatures: ["hand-tracking"],
      })
    );

    // The rig only moves for XR sessions: on desktop the OrbitControls
    // orbit the camera's local position, so an offset group would skew them.
    this.renderer.instance.xr.addEventListener("sessionstart", () => {
      this.cameraGroup.position.copy(this.xrStartPosition);
    });
    this.renderer.instance.xr.addEventListener("sessionend", () => {
      this.cameraGroup.position.set(0, 0, 0);
    });

    // samir believes this gets hit when we're in XR
    this.renderer.instance.setAnimationLoop(() => {
      this.controller.update();
      this.handLocomotion.update();
      if (this.networking?.canSendEmbodiment) {
        this.networking.sendEmbodiment(
          this.camera.instance.matrixWorld,
          this.controller.controller1.matrixWorld,
          this.controller.controller2.matrixWorld
        );
      }

      this.renderer.instance.render(this.scene, this.camera.instance);
    });

    this.sizes.on("resize", () => {
      this.resize();
      this.camera.resize();
      this.renderer.resize();
    });
    this.time.on("tick", () => {
      this.update();
    });
  }

  /** Continuous colour for a speed in km/h (viridis, clamped to speedColorMax). */
  speedColor(kmh, target = new THREE.Color()) {
    const stops = this.viridisStops;
    const t = Math.min(Math.max(kmh / this.speedColorMax, 0), 1) * (stops.length - 1);
    const i = Math.min(Math.floor(t), stops.length - 2);
    return target.copy(stops[i]).lerp(stops[i + 1], t - i);
  }

  /** Colour for one fix under the current colour mode. */
  fixColor(state, speedKmh, target = new THREE.Color()) {
    if (this.colorMode === "speed") return this.speedColor(speedKmh, target);
    const s = Math.min(5, Math.max(0, state));
    return target.copy(this.movementStateColors[s]);
  }

  resize() {
    console.log("resized occured");
    this.camera.resize();
  }

  update() {
    this.camera.update();
    if (!this.isXRActive()) {
      // this is executed when out of XR i.e. desktop
      this.cameraGroup.updateMatrixWorld();
      this.camera.instance.updateMatrixWorld();
      this.pointer.hover();
    }
    this.world.update();
  }
  isXRActive() {
    return this.renderer.instance.xr.isPresenting;
  }
  destroy() {
    this.sizes.off("resize");
    this.time.off("tick");

    this.scene.traverse((child) => {
      // Test if it's a mesh
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        // Loop through the material properties
        for (const key in child.material) {
          const value = child.material[key];

          // Test if there is a dispose function
          if (value && typeof value.dispose === "function") {
            value.dispose();
          }
        }
      }
    });
    this.camera.controls.dispose();
    this.renderer.instance.dispose();
    if (this.debug.active) {
      this.debug.ui.destroy();
    }
  }
}
