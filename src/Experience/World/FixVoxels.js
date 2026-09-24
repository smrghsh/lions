import * as THREE from "three";
import Experience from "../Experience.js";

/**
 * One small cube per GPS fix, as a single InstancedMesh. Each cube is
 * selectable through the same Pointer path as the tracks: hovering shows a
 * highlight frame, clicking snaps the callout to that fix.
 */
export default class FixVoxels extends THREE.InstancedMesh {
  constructor(lionPath) {
    const experience = new Experience();
    const topobath = experience.world.topobath;
    const size = experience.voxelSizeMeters / topobath.metersPerUnit;
    const count = lionPath.points.length;

    super(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      count
    );

    this.experience = experience;
    this.lionPath = lionPath;
    this.size = size;
    this.name = `${lionPath.name}-voxels`;

    // brahma Pointer protocol
    this.selectable = true;
    this.active = true;
    this.hover = false;
    this.experience.selectableObjects.push(this);

    this.frustumCulled = false; // bounding sphere of 20k instances is the whole map anyway
    this._matrix = new THREE.Matrix4();
    this._color = new THREE.Color();

    this.updatePositions();
    this.updateColors();

    // hover highlight: a slightly larger wireframe cube
    this.highlight = new THREE.Mesh(
      new THREE.BoxGeometry(size * 1.6, size * 1.6, size * 1.6),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        wireframe: true,
        depthTest: false,
      })
    );
    this.highlight.renderOrder = 998;
    this.highlight.visible = false;
    this.add(this.highlight);
  }

  raycast(raycaster, intersects) {
    if (!this.visible) return;
    super.raycast(raycaster, intersects);
  }

  /** Re-place every cube on its fix (after exaggeration changes). */
  updatePositions() {
    const pts = this.lionPath.points;
    const half = this.size / 2;
    for (let i = 0; i < pts.length; i++) {
      this._matrix.makeTranslation(pts[i].x, pts[i].y + half, pts[i].z);
      this.setMatrixAt(i, this._matrix);
    }
    this.instanceMatrix.needsUpdate = true;
    this.computeBoundingSphere();
  }

  /** Recolour every cube under the current colour mode. */
  updateColors() {
    const { states, speeds } = this.lionPath;
    for (let i = 0; i < this.count; i++) {
      this.experience.fixColor(states[i], speeds[i], this._color);
      this.setColorAt(i, this._color);
    }
    this.instanceColor.needsUpdate = true;
  }

  onHover() {
    this.hover = true;
  }

  onUnhover() {
    this.hover = false;
    this.highlight.visible = false;
  }

  onSelect(hit) {
    const idx = hit?.instanceId ?? this.experience.pointer.currentIntersect?.instanceId;
    if (idx === undefined || idx === null) return;
    const callout = this.experience.world?.callout;
    if (!callout) return;
    callout.setLionPath(this.lionPath, idx);
    callout.updateFromPointIndex();
    callout.visible = true;
  }

  /** Per frame: follow the hovered instance with the highlight frame. */
  update() {
    const hit = this.experience.pointer.currentIntersect;
    if (this.hover && hit && hit.object === this && hit.instanceId !== undefined) {
      const p = this.lionPath.points[hit.instanceId];
      this.highlight.position.set(p.x, p.y + this.size / 2, p.z);
      this.highlight.visible = true;
    } else {
      this.highlight.visible = false;
    }
  }
}
