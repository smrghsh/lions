import { Path } from "../brahma/Brahma.js";

/**
 * brahma's Path with the selection hook rewired for lion data. Path.onSelect
 * assumes a seal (depth, heart rate, sleep state...); here the nearest fix
 * is handed to the callout as one object instead. Everything else (raycast
 * wrapper, hover colours, the hover marker) is inherited unchanged.
 */
export default class SelectablePath extends Path {
  constructor(...args) {
    super(...args);
    // Raycaster.intersectObjects recurses into children and ignores
    // visibility, so the Line2 inside a hidden track could still be picked
    // (the Pointer walks back up to this group). Gate the child's raycast
    // on the group's visibility, and keep the hover marker out of picking.
    const lineRaycast = this.line.raycast.bind(this.line);
    this.line.raycast = (raycaster, intersects) => {
      if (this.visible) lineRaycast(raycaster, intersects);
    };
    if (this.marker) this.marker.raycast = () => {};
  }

  raycast(raycaster, intersects) {
    if (!this.visible) return;
    super.raycast(raycaster, intersects);
  }

  onSelect(location) {
    if (this.marker) {
      this.setSphere(location);
    }

    const callout = this.experience.world?.callout;
    if (!callout || !this.lionPath) return;

    const nearestData = this.lionPath.findNearestPoint(location);
    if (!nearestData) return;

    // Snap the callout to the fix itself rather than the clicked spot on
    // the segment, then let it fill in the display, graphs and networking.
    callout.setLionPath(this.lionPath, nearestData.index);
    callout.updateFromPointIndex();
    callout.visible = true;
  }
}
