import * as THREE from "three";

/**
 * Procedural low-poly puma used as the callout's orientation marker (the
 * seals repo used a Seal glb here). Built facing -z (north at heading 0),
 * about 1 unit nose-to-rump, so the callout scales it like the seal.
 */
export default class Lion extends THREE.Group {
  constructor() {
    super();

    const tawny = new THREE.MeshStandardMaterial({
      color: 0xc19a6b,
      roughness: 0.85,
      metalness: 0.0,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x3b2a1a,
      roughness: 0.9,
    });
    const pale = new THREE.MeshStandardMaterial({
      color: 0xe8dcc8,
      roughness: 0.9,
    });

    // body: capsule along z
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.55, 4, 10), tawny);
    body.rotation.x = Math.PI / 2;
    body.position.set(0, 0.42, 0.05);
    this.add(body);

    // chest / muzzle-side pale belly
    const belly = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.45, 3, 8), pale);
    belly.rotation.x = Math.PI / 2;
    belly.position.set(0, 0.34, 0.05);
    this.add(belly);

    // neck + head
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.22, 8), tawny);
    neck.rotation.x = -Math.PI / 3;
    neck.position.set(0, 0.52, -0.36);
    this.add(neck);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), tawny);
    head.position.set(0, 0.6, -0.47);
    this.add(head);

    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.1, 0.12), pale);
    muzzle.position.set(0, 0.55, -0.59);
    this.add(muzzle);

    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.03), dark);
    nose.position.set(0, 0.575, -0.655);
    this.add(nose);

    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.1, 5), tawny);
      ear.position.set(side * 0.09, 0.73, -0.45);
      ear.rotation.z = -side * 0.35;
      this.add(ear);

      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 6), dark);
      eye.position.set(side * 0.06, 0.63, -0.6);
      this.add(eye);
    }

    // legs: four slightly splayed cylinders
    const legGeo = new THREE.CylinderGeometry(0.045, 0.04, 0.4, 7);
    const legPositions = [
      [-0.11, 0.2, -0.2],
      [0.11, 0.2, -0.2],
      [-0.11, 0.2, 0.28],
      [0.11, 0.2, 0.28],
    ];
    for (const [x, y, z] of legPositions) {
      const leg = new THREE.Mesh(legGeo, tawny);
      leg.position.set(x, y, z);
      this.add(leg);
      const paw = new THREE.Mesh(new THREE.SphereGeometry(0.05, 7, 6), tawny);
      paw.position.set(x, 0.03, z - 0.02);
      paw.scale.set(1, 0.6, 1.2);
      this.add(paw);
    }

    // tail: long, thick, curving down then up (the puma signature)
    const tailCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.42, 0.38),
      new THREE.Vector3(0, 0.3, 0.6),
      new THREE.Vector3(0, 0.18, 0.82),
      new THREE.Vector3(0, 0.22, 1.0),
      new THREE.Vector3(0, 0.34, 1.08),
    ]);
    const tail = new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 16, 0.035, 6, false), tawny);
    this.add(tail);
    const tailTip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), dark);
    tailTip.position.copy(tailCurve.getPoint(1));
    this.add(tailTip);

    this.name = "lion";
  }
}
