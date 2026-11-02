import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { decodeDepth16, encodeDepth16 } from '../src/depth-codec.js';
import { classifyOcclusion, segmentId, PALETTE } from '../src/reference-package.js';
import { createMannequin } from '../src/mannequin.js';

test('all 65536 packed depth codes round-trip exactly, including background', () => {
  const range = { near: 0.15, far: 17.8 };
  for (let q = 0; q <= 65535; q++) {
    const distance = decodeDepth16(q >> 8, q & 255, range);
    const encoded = encodeDepth16(distance, range);
    assert.equal(encoded[0] * 256 + encoded[1], q);
  }
  for (const distance of [0.15, 0.31, 1, 4.1234567, 17.79]) {
    const [red, green] = encodeDepth16(distance, range);
    assert.ok(Math.abs(decodeDepth16(red, green, range) - distance) <= (range.far - range.near) / 131070);
  }
});

test('every actual mannequin mesh has an anatomical segment and a unique palette color', () => {
  const mannequin = createMannequin(new THREE.Scene());
  for (const mesh of mannequin.pickables) assert.ok(PALETTE[segmentId(mesh.userData.jointId)]);
  assert.equal(new Set(PALETTE.map(entry => entry.rgb.join(','))).size, PALETTE.length);
  assert.notEqual(segmentId('leftShoulder'), segmentId('rightShoulder'));
  assert.notEqual(segmentId('leftKnee'), segmentId('rightKnee'));
  assert.throws(() => segmentId('unmapped'), /Unmapped/);
});

for (const orthographic of [false, true]) test(`occlusion uses nearest clipped geometry (${orthographic ? 'orthographic' : 'perspective'})`, () => {
  const camera = orthographic ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10) : new THREE.PerspectiveCamera(40, 1, 0.1, 10);
  camera.position.z = 4; camera.updateMatrixWorld(true);
  const own = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial());
  own.userData.jointId = 'leftWrist'; own.updateMatrixWorld(true);
  const blocker = own.clone(); blocker.position.z = 1; blocker.userData = { jointId: 'rightShoulder' }; blocker.updateMatrixWorld(true);
  const point = { world: [0, 0, 0], distance: 4, inFrame: true };
  assert.equal(classifyOcclusion(point, [own], camera, [11]).status, 'visible');
  const hidden = classifyOcclusion(point, [own, blocker], camera, [11]);
  assert.equal(hidden.status, 'occluded'); assert.equal(hidden.occluderJoint, 'rightShoulder');
  blocker.position.x = 1; blocker.updateMatrixWorld(true);
  assert.equal(classifyOcclusion(point, [own, blocker], camera, [11]).occluded, false);
  assert.equal(classifyOcclusion({ ...point, inFrame: false }, [own], camera, [11]).status, 'out-of-frame');
  assert.equal(classifyOcclusion(null, [own], camera, [11]).status, 'unavailable');
  assert.equal(classifyOcclusion(point, [], camera, [11]).status, 'unknown');
  blocker.position.set(0, 0, 3.95); blocker.scale.setScalar(0.1); blocker.updateMatrixWorld(true);
  assert.equal(classifyOcclusion(point, [own, blocker], camera, [11]).status, 'visible'); // Blocker is before near plane.
});
