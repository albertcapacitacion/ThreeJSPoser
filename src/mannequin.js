import * as THREE from 'three';
import { JOINTS, FINGER_LENGTHS } from './rig.js';

export function createMannequin(scene) {
  const root = new THREE.Group();
  scene.add(root);
  const bones = {}, markers = [], pickables = [];
  const body = new THREE.MeshStandardMaterial({ color: 0x81c6ba, roughness: .57, metalness: .05 });
  const jointMaterial = new THREE.MeshStandardMaterial({ color: 0x49736f, roughness: .7 });
  const sphere = new THREE.SphereGeometry(1, 28, 20);

  function part(id, geometry, position, scale, material = body) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.jointId = id;
    bones[id].add(mesh);
    pickables.push(mesh);
    return mesh;
  }
  function ellipsoid(id, position, scale, material) { return part(id, sphere, position, scale, material); }
  function segment(id, from, to, width, depth = width) {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const length = a.distanceTo(b);
    const radius = Math.min(width, length * .35);
    const geometry = new THREE.CapsuleGeometry(radius, Math.max(.001, length - radius * 2), 6, 18);
    const mesh = part(id, geometry, a.clone().add(b).multiplyScalar(.5).toArray(), [width / radius, 1, depth / radius]);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
    return mesh;
  }
  for (const j of JOINTS) {
    const bone = new THREE.Group();
    bone.name = j.id;
    bone.position.set(...j.offset);
    (j.parent ? bones[j.parent] : root).add(bone);
    bones[j.id] = bone;
    const finger = /(?:Index|Middle|Ring|Little|Thumb)/.test(j.id);
    const radius = finger ? .006 : .012;
    const color = j.id.startsWith('left') ? 0x4d95ff : j.id.startsWith('right') ? 0xef8767 : 0xe1b95b;
    const marker = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: .85 }));
    marker.userData.jointId = j.id;
    marker.renderOrder = 5;
    bone.add(marker);
    markers.push(marker);
    // Finger joints have smaller bearings; the pieces keep a visible seam.
    if (j.parent) ellipsoid(j.id, [0, 0, 0], [finger ? .0075 : .027, finger ? .0075 : .027, finger ? .0075 : .027], jointMaterial);
  }
  ellipsoid('pelvis', [0, -.005, 0], [.167, .112, .112]);
  ellipsoid('lumbar', [0, .042, 0], [.115, .078, .087]);
  ellipsoid('spine', [0, .045, 0], [.139, .086, .1]);
  ellipsoid('chest', [0, .067, 0], [.195, .132, .116]);
  segment('neck', [0, .008, 0], [0, .09, 0], .041);
  ellipsoid('head', [0, .064, 0], [.092, .122, .096]);
  ellipsoid('head', [0, .044, .092], [.018, .026, .019]);

  for (const side of ['left', 'right']) {
    const s = side === 'left' ? 1 : -1;
    segment(`${side}Clavicle`, [s * .01, 0, 0], [s * .12, 0, 0], .032);
    ellipsoid(`${side}Shoulder`, [0, -.017, 0], [.055, .062, .059]);
    segment(`${side}Shoulder`, [0, -.035, 0], [0, -.263, 0], .046, .048);
    segment(`${side}Elbow`, [0, -.022, 0], [0, -.123, 0], .039, .041);
    segment(`${side}Forearm`, [0, -.008, 0], [0, -.114, 0], .031, .033);
    ellipsoid(`${side}Wrist`, [0, -.044, .001], [.04, .045, .023]);
    for (const [finger, lengths] of Object.entries(FINGER_LENGTHS)) {
      lengths.forEach((length, i) => {
        const width = finger === 'Thumb' ? .010 : finger === 'Little' ? .007 : .0085;
        segment(`${side}${finger}${i + 1}`, [0, -.003, 0], [0, -length + .002, 0], width, width * .9);
      });
    }
    ellipsoid(`${side}Hip`, [0, -.028, 0], [.079, .087, .085]);
    segment(`${side}Hip`, [0, -.055, 0], [0, -.397, 0], .069, .075);
    ellipsoid(`${side}Knee`, [0, -.01, .009], [.048, .044, .05]);
    segment(`${side}Knee`, [0, -.03, 0], [0, -.406, 0], .045, .051);
    ellipsoid(`${side}Ankle`, [0, -.027, .037], [.048, .052, .086]);
    ellipsoid(`${side}Toes`, [0, -.006, .025], [.049, .032, .048]);
  }

  function sync(pose) {
    for (const j of JOINTS) bones[j.id].rotation.set(...pose.rotations[j.id].map(THREE.MathUtils.degToRad), 'XYZ');
    root.updateMatrixWorld(true);
  }
  function highlight(id) {
    for (const marker of markers) {
      const active = marker.userData.jointId === id;
      marker.scale.setScalar(active ? 1.5 : 1);
      marker.material.opacity = active ? 1 : .8;
    }
  }
  function setMarkersVisible(visible) { for (const m of markers) m.visible = visible; }
  return { root, bones, markers, pickables, sync, highlight, setMarkersVisible };
}
