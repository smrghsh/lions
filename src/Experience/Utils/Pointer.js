import * as THREE from "three";
import Experience from "../Experience.js";

export default class Pointer {
  constructor() {
    this.experience = new Experience();

    // Raycaster with unified configuration
    this.raycaster = new THREE.Raycaster();
    this.raycaster.near = 0.001; // Start raycasting very close (1mm)
    this.raycaster.far = 1000; // Raycast up to 1000 units away
    this.raycaster.params = {
      Line: { threshold: 0.02 }, // Larger for VR controller ease
      Line2: { threshold: 0.02 }, // Larger for VR controller ease
      Mesh: { threshold: 0.005 },
    };

    // Input mode tracking
    this.mode = null; // 'camera' or 'controller'
    this.camera = null;
    this.mouse = null;
    this.controller = null;

    // Intersection state (merged from RaycastHandler)
    this.currentIntersect = null;
    this.lastTriggeredObject = null;

    // Selection cooldown (250ms)
    this.selectionCooldown = 0;
    this.lastSelectionTime = 0;

    // VR pointer cone visual
    this.pointerCone = null;
    this.createPointerCone();
  }

  createPointerCone() {
    // Thinner cone for more precise visual feedback
    const geometry = new THREE.ConeGeometry(0.002, 0.3, 8);
    const material = new THREE.MeshBasicMaterial({
      color: 0xff0000, // RED for debugging - change to white later
      transparent: true,
      opacity: 0.8,
    });
    this.pointerCone = new THREE.Mesh(geometry, material);
    this.pointerCone.position.z = -0.15; // Closer to controller
    this.pointerCone.rotation.x = -Math.PI / 2;
    this.pointerCone.visible = false;

    // Debug ray line to visualize actual raycast
    this.debugRayLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -10),
      ]),
      new THREE.LineBasicMaterial({ color: 0x00ff00 }) // Green line
    );
    this.debugRayLine.visible = false;
  }

  setSource(mode, data) {
    this.mode = mode;

    if (mode === "camera") {
      this.camera = data.camera;
      this.mouse = data.mouse;
      this.controller = null;
      // Hide VR pointer cone in desktop mode
      if (this.pointerCone.parent) {
        this.pointerCone.visible = false;
      }
    } else if (mode === "controller") {
      this.controller = data;
      this.camera = null;
      this.mouse = null;

      // Attach pointer cone to controller if not already attached
      if (this.pointerCone.parent !== this.controller) {
        if (this.pointerCone.parent) {
          this.pointerCone.parent.remove(this.pointerCone);
        }
        this.controller.add(this.pointerCone);
      }
      this.pointerCone.visible = true;

      // Attach debug ray line to controller
      if (this.debugRayLine.parent !== this.controller) {
        if (this.debugRayLine.parent) {
          this.debugRayLine.parent.remove(this.debugRayLine);
        }
        this.controller.add(this.debugRayLine);
      }
      this.debugRayLine.visible = true; // Enable for debugging
    }
  }

  hover() {
    // Update raycaster based on mode
    if (this.mode === "camera" && this.camera && this.mouse) {
      this.raycaster.setFromCamera(this.mouse, this.camera);
    } else if (this.mode === "controller" && this.controller) {
      // Set raycaster from controller
      const tempMatrix = new THREE.Matrix4();
      tempMatrix.identity().extractRotation(this.controller.matrixWorld);

      this.raycaster.ray.origin.setFromMatrixPosition(
        this.controller.matrixWorld
      );
      this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
    } else {
      //   console.log(
      //     "Pointer.hover() - no valid source. mode:",
      //     this.mode,
      //     "camera:",
      //     this.camera,
      //     "mouse:",
      //     this.mouse
      //   );
      return; // No valid source
    }

    // Perform raycasting (merged from RaycastHandler.handleRaycast)
    const rawIntersects = this.raycaster.intersectObjects(
      this.experience.selectableObjects,
      true
    );

    // console.log(
    //   "Pointer.hover() - selectableObjects count:",
    //   this.experience.selectableObjects.length,
    //   "rawIntersects:",
    //   rawIntersects.length
    // );

    // Process intersections to find Path parents
    let validIntersects = [];
    for (const intersect of rawIntersects) {
      let obj = intersect.object;
      //   console.log(
      //     "Raw intersect object:",
      //     obj.type,
      //     obj.name,
      //     "selectable:",
      //     obj.selectable,
      //     "parent:",
      //     obj.parent?.type
      //   );

      // Traverse up to find Path parent or Selectable parent
      while (obj && !obj.isPath && !obj.selectable && obj.parent) {
        // console.log(
        //   "Traversing up from:",
        //   obj.type,
        //   "to parent:",
        //   obj.parent?.type
        // );
        if (obj.parent.isPath) {
          obj = obj.parent;
          break;
        }
        if (obj.parent.selectable) {
          obj = obj.parent;
          break;
        }
        obj = obj.parent;
      }

      if (obj.isPath) {
        // Found valid Path
        intersect.object = obj;
        validIntersects.push(intersect);
        // console.log("Found Path:", obj.name);
      } else if (obj.active || obj.selectable) {
        // Other selectable object
        validIntersects.push(intersect);
        // console.log(
        //   "Found selectable:",
        //   obj.name,
        //   "active:",
        //   obj.active,
        //   "selectable:",
        //   obj.selectable
        // );
      } else {
        // console.log(
        //   "Skipped object:",
        //   obj.name,
        //   "active:",
        //   obj.active,
        //   "selectable:",
        //   obj.selectable
        // );
      }
    }

    // console.log("Valid intersects:", validIntersects.length);

    // Handle hover state changes
    if (validIntersects.length) {
      if (!this.currentIntersect) {
        // Entering new object
        this.currentIntersect = validIntersects[0];

        try {
          if (this.currentIntersect.object.onHover) {
            this.currentIntersect.object.onHover();
          }

          // Trigger haptic feedback in VR mode only
          if (this.mode === "controller") {
            this.experience.controller?.pointerController?.padControls?.pulse(
              25,
              0.125
            );
          }
        } catch (error) {
          console.error("Error calling onHover:", error);
        }

        // Exit other intersected objects
        for (let i = 1; i < validIntersects.length; i++) {
          try {
            if (
              validIntersects[i].object.active &&
              validIntersects[i].object.onUnhover
            ) {
              validIntersects[i].object.onUnhover();
            }
          } catch (error) {
            console.error("Error calling onUnhover:", error);
          }
        }
      } else {
        // Check if still hovering same object
        if (
          this.currentIntersect.object.uuid === validIntersects[0].object.uuid
        ) {
          // Same object - update marker position for Path
          const hit = validIntersects[0];
          const obj = hit.object;

          if (obj.isPath && obj.marker) {
            const p = hit.pointOnLine || hit.point;
            if (p && obj.setSphere) {
              try {
                obj.setSphere(p);
              } catch (error) {
                console.error("Error updating marker:", error);
              }
            }
          }
        } else {
          // Different object - exit old, enter new
          try {
            if (this.currentIntersect.object.onUnhover) {
              this.currentIntersect.object.onUnhover();
            }
          } catch (error) {
            console.error("Error calling onUnhover:", error);
          }

          this.currentIntersect = validIntersects[0];

          try {
            if (this.currentIntersect.object.onHover) {
              this.currentIntersect.object.onHover();
            }

            // Trigger haptic feedback in VR mode only
            if (this.mode === "controller") {
              this.experience.controller?.pointerController?.padControls?.pulse(
                25,
                0.125
              );
            }
          } catch (error) {
            console.error("Error calling onHover:", error);
          }

          // Exit other intersected objects
          for (let i = 1; i < validIntersects.length; i++) {
            try {
              if (
                validIntersects[i].object.active &&
                validIntersects[i].object.onUnhover
              ) {
                validIntersects[i].object.onUnhover();
              }
            } catch (error) {
              console.error("Error calling onUnhover:", error);
            }
          }
        }
      }
    } else {
      // No intersections - exit everything
      if (this.currentIntersect) {
        this.experience.selectableObjects.forEach((obj) => {
          if (obj.hover && obj.onUnhover) {
            try {
              obj.onUnhover();
            } catch (error) {
              console.error("Error calling onUnhover:", error);
            }
          }
        });
      }
      this.currentIntersect = null;
    }
  }

  select() {
    // Check cooldown
    const now = performance.now();
    if (now - this.lastSelectionTime < this.selectionCooldown) {
      return;
    }
    this.lastSelectionTime = now;

    // Hide previous sphere if exists
    if (this.lastTriggeredObject && this.lastTriggeredObject.hideSphere) {
      try {
        this.lastTriggeredObject.hideSphere();
      } catch (error) {
        console.error("Error hiding sphere:", error);
      }
    }

    // Trigger selection on current intersect
    if (this.currentIntersect) {
      try {
        if (this.currentIntersect.object.isPath) {
          // Use pointOnLine for precise tracking
          const p =
            this.currentIntersect.pointOnLine || this.currentIntersect.point;

          if (this.currentIntersect.object.onSelect) {
            this.currentIntersect.object.onSelect(p);
          }

          this.lastTriggeredObject = this.currentIntersect.object;
        } else {
          // Non-path selectables (e.g. fix voxels) get the whole hit so they
          // can read instanceId / point.
          if (this.currentIntersect.object.onSelect) {
            this.currentIntersect.object.onSelect(this.currentIntersect);
          }
        }
      } catch (error) {
        console.error("Error calling onSelect:", error);
      }
    }
  }
}
