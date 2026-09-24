import * as THREE from "three";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import Experience from "../Experience.js";

// Hand-tracked locomotion, ported from caye's GrabLocomotion + HandBrush
// hand setup. Left-fist grab-and-pull: make a fist with the left hand to
// grab the world, pull to glide the rig the opposite way, open to let go.
// Mirrors Locomotion.js's controller squeeze pattern, so it feels the same
// as the Quest grip-and-pull.
//
// Independent of Controller.js: this only ever reads three's XR hand
// groups (renderer.xr.getHand), which are populated solely when the input
// source carries `hand` joints (Vision Pro, or Quest with controllers set
// down). Controllers with gamepads never produce joints, so the Quest
// controller path is unaffected.
//
// Transiently lost joints get a grace period instead of dropping the grab
// (visionOS loses them for a few frames at a time), re-baselining on return
// so the gap never lands as one lurching pull. The gesture is measured in
// rig-local (reference-space, physical) coordinates, so the rig's own
// motion never feeds back into the pull.

const GRAB_CURL = 0.09; // avg fingertip->wrist distance below this = fist (physical m)
const RELEASE_CURL = 0.12; // hysteresis
const SPEED = 4; // same scalar as Locomotion.js's speedScalar
const LOST_TIMEOUT = 0.4; // s of missing joints before the grab drops
const MAX_DT = 0.1; // clamp so a stalled frame can't count as a long loss
const TIPS = [
  "index-finger-tip",
  "middle-finger-tip",
  "ring-finger-tip",
  "pinky-finger-tip",
];

export default class HandLocomotion {
  constructor() {
    this.experience = new Experience();
    this.renderer = this.experience.renderer.instance;
    this.cameraGroup = this.experience.cameraGroup;

    // skinned generic-hand mesh, vendored into static/models/generic-hand/
    // so nothing fetches from a CDN in-headset
    const factory = new XRHandModelFactory().setPath("./models/generic-hand/");
    this.hands = [0, 1].map((i) => {
      const hand = this.renderer.xr.getHand(i);
      hand.add(factory.createHandModel(hand, "mesh"));
      hand.addEventListener("connected", (e) => {
        hand.userData.handedness = e.data?.handedness ?? null;
      });
      hand.addEventListener("disconnected", () => {
        hand.userData.handedness = null;
      });
      this.cameraGroup.add(hand);
      return hand;
    });

    this.grabbing = false;
    this.anchor = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._lostFor = 0;
    this._rearm = false; // joints just returned: re-anchor before moving
    this._lastTime = null;
    this._disabled = false; // tripped by an unexpected error; never takes the render loop down

    console.info(`[HandLocomotion.js] initialized (left-fist grab-and-pull)`);
  }

  _leftHand() {
    return this.hands.find((h) => h.userData.handedness === "left");
  }

  // Average fingertip-to-wrist distance; null when joints are missing.
  _curl(hand) {
    const wrist = hand.joints?.["wrist"];
    if (!wrist) return null;
    let sum = 0;
    let n = 0;
    for (const name of TIPS) {
      const j = hand.joints[name];
      if (j && j.visible !== false) {
        sum += j.position.distanceTo(wrist.position);
        n++;
      }
    }
    return n === TIPS.length ? sum / n : null;
  }

  update() {
    if (this._disabled) return;
    try {
      this._update();
    } catch (err) {
      this._disabled = true;
      this.grabbing = false;
      console.error("[HandLocomotion.js] disabled after error:", err);
    }
  }

  _update() {
    const now = performance.now();
    const dt =
      this._lastTime === null
        ? 0.016
        : Math.min((now - this._lastTime) / 1000, MAX_DT);
    this._lastTime = now;

    if (!this.experience.isXRActive()) {
      this.grabbing = false;
      return;
    }
    const hand = this._leftHand();
    const curl = hand ? this._curl(hand) : null;
    if (curl === null) {
      // grace period: joints flicker out for a few frames on visionOS;
      // dropping the grab instantly stutters every long pull
      if (this.grabbing) {
        this._lostFor += dt;
        this._rearm = true;
        if (this._lostFor > LOST_TIMEOUT) {
          this.grabbing = false;
          this._rearm = false;
        }
      }
      return;
    }
    this._lostFor = 0;

    const wrist = hand.joints["wrist"];
    if (!this.grabbing && curl < GRAB_CURL) {
      this.grabbing = true;
      this.anchor.copy(wrist.position);
    } else if (this.grabbing && curl > RELEASE_CURL) {
      this.grabbing = false;
    }

    if (this.grabbing) {
      if (this._rearm) {
        this._rearm = false;
        this.anchor.copy(wrist.position);
        return;
      }
      const rig = this.cameraGroup;
      this._delta
        .copy(wrist.position)
        .sub(this.anchor) // physical, rig-local
        .multiplyScalar(rig.scale.x * SPEED); // into world units
      rig.position.sub(this._delta);
      this.anchor.copy(wrist.position);
    }
  }
}
