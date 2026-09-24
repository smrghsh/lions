import * as THREE from "three";
import Experience from "../Experience";

/**
 * Translucent plane at elevation 0 (world y = 0). Monterey Bay occupies the
 * south-east corner of the tile grid, so this doubles as the water surface
 * over the bathymetry. Sized to the Topobath footprint.
 */
export default class SeaLevelPlane {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;
    this.debug = this.experience.debug;
    this.debugFolder = this.debug.ui.addFolder("Sea Level Marker");

    const topobath = this.experience.world.topobath;
    const width = topobath?.planeWorldWidth ?? 60;
    const height = topobath?.planeWorldHeight ?? 60;

    this.geometry = new THREE.PlaneGeometry(1, 1, 100, 100);
    this.material = new THREE.MeshBasicMaterial({
      color: 0x0077b6,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    this.plane = new THREE.Mesh(this.geometry, this.material);
    this.plane.rotation.x = -Math.PI / 2;
    this.plane.position.y = 0.001;
    this.plane.scale.x = width;
    this.plane.scale.y = height;

    this.material2 = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      wireframe: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
    });
    // second plane with same as first
    this.plane2 = new THREE.Mesh(this.geometry, this.material2);
    this.plane2.rotation.x = -Math.PI / 2;
    this.plane2.position.y = 0.002;
    this.plane2.scale.x = width;
    this.plane2.scale.y = height;
    this.plane2.visible = false; // grid is noisy over land; toggle in debug

    this.seaLevelPlaneGroup = new THREE.Group();
    this.seaLevelPlaneGroup.add(this.plane);
    this.seaLevelPlaneGroup.add(this.plane2);
    this.scene.add(this.seaLevelPlaneGroup);
    this.debugFolder.add(this.seaLevelPlaneGroup, "visible").name("Sea level");
    this.debugFolder.add(this.plane2, "visible").name("Grid");
  }
}
