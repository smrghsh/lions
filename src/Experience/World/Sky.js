import * as THREE from "three";
import Experience from "../Experience";

export default class Sky {
  constructor() {
    this.experience = new Experience();
    this.scene = this.experience.scene;
    this.resources = this.experience.resources;
    this.image = this.resources.items.skyTexture;
    this.image.mapping = THREE.EquirectangularReflectionMapping;
    this.image.colorSpace = THREE.LinearSRGBColorSpace;
    this.scene.background = this.image;
    this.scene.environment = this.image;
    this.geometry = new THREE.SphereGeometry(1000, 64, 64);
    this.geometry.scale(1, 1, 1);
    this.material = new THREE.MeshBasicMaterial({ map: this.image });
    this.skySphere = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.skySphere);
  }
}
