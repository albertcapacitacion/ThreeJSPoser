import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { JOINTS, createPose } from '../src/rig.js';
import { createMannequin } from '../src/mannequin.js';
import { captureRigTransforms, createCompletePoseExport } from '../src/pose-export.js';
import { reconstructPose } from '../src/reconstruct-pose.js';

function near(actual, expected, tolerance = 1e-10) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance, `${value} != ${expected[index]}`));
}

test('JSON alone reconstructs rest/current joints, primitive vertices, intermediate transforms and camera', async () => {
  const scene = new THREE.Scene();
  const parent = new THREE.Group();
  parent.position.set(.2, -.4, .7); parent.rotation.set(.1, -.2, .3); parent.scale.setScalar(1.2); scene.add(parent);
  const mannequin = createMannequin(parent), pose = createPose();
  mannequin.root.position.set(.1, 0, -.1);
  mannequin.sync(pose);
  const restTransforms = captureRigTransforms(mannequin);
  pose.limits = false;
  pose.rotations.leftShoulder = [-53.123456789, 22, 64];
  pose.rotations.rightShoulder = [-17, -23, -11];
  pose.rotations.leftIndex2 = [61, 13, -2];
  pose.rotations.rightKnee = [73, 4, 7];
  mannequin.sync(pose);
  const camera = new THREE.OrthographicCamera(-1.3, 1.3, 1.1, -1.1, .01, 80);
  const target = new THREE.Vector3(.2, .9, -.1);
  camera.position.copy(target).add(new THREE.Vector3(0, 0, 5)); camera.lookAt(target); camera.zoom = 1.7; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  const view = { camera, target, name: 'Front', viewport: { x: 0, y: 0, width: 650, height: 550 } };
  const renderer = { getPixelRatio: () => 2, getDrawingBufferSize: vector => vector.set(1300, 1100) };
  const proceduralSource = { files: await Promise.all(['rig.js', 'mannequin.js'].map(async name => ({ name, source: await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8') }))) };
  const before = captureRigTransforms(mannequin), cameraBefore = camera.toJSON();
  const exported = await createCompletePoseExport({ mannequin, pose, restTransforms, views: [view], activeView: 0, renderer, proceduralSource });
  const data = JSON.parse(JSON.stringify(exported));
  const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(data.coordinateSystem.threeVersion, packageInfo.dependencies.three);
  assert.deepEqual(captureRigTransforms(mannequin), before);
  assert.deepEqual(camera.toJSON(), cameraBefore);
  assert.deepEqual(data.pose.rotations, pose.rotations);
  assert.equal(data.validation.jointCount, 54);
  assert.equal(data.validation.bodySegmentCount, mannequin.pickables.length);
  assert.equal(data.validation.everyJointHasValidParent, true);
  assert.equal(data.validation.everyNodeHasValidParent, true);
  assert.equal(data.validation.allTransformValuesFinite, true);
  assert.deepEqual(data.validation.missingOrUnsupportedData, []);
  assert.ok(data.geometry.resources.every(resource => !resource.data));
  assert.ok(data.geometry.resources.length < data.geometry.segments.length);
  for (const rest of [true, false]) {
    const rebuilt = reconstructPose(data, rest);
    const expected = rest ? restTransforms : before;
    for (const entry of data.rig.nodes) {
      const node = rebuilt.nodes.get(entry.id), saved = expected[entry.id];
      near(node.getWorldPosition(new THREE.Vector3()).toArray(), saved.world.position);
      near(node.matrixWorld.toArray(), saved.world.matrix);
      assert.ok(node.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion().fromArray(saved.world.quaternion)) < 1e-7);
      if (entry.parent) assert.equal(node.parent, rebuilt.nodes.get(entry.parent));
    }
    for (const joint of JOINTS) {
      const entry = data.rig.joints.find(item => item.name === joint.id);
      assert.equal(entry.parent, joint.parent);
      if (rest) near(data.restPose.transforms[entry.node].local.eulerDegrees, joint.rest);
    }
    if (rest) {
      // Test actual anatomical mapping and arms-down geometry in root coordinates.
      const localPoint = name => rebuilt.nodes.get(data.rig.root).worldToLocal(rebuilt.joints[name].getWorldPosition(new THREE.Vector3()));
      assert.ok(localPoint('leftShoulder').x > localPoint('rightShoulder').x);
      for (const side of ['left', 'right']) assert.ok(localPoint(`${side}Wrist`).y < localPoint(`${side}Shoulder`).y);
    }
    for (const [index, segment] of data.geometry.segments.entries()) {
      const original = mannequin.pickables.find(mesh => mesh.geometry.uuid === segment.geometry);
      const geometry = rebuilt.nodes.get(segment.node).geometry;
      near([...geometry.attributes.position.array], [...original.geometry.attributes.position.array]);
      assert.equal(segment.geometryType, geometry.type, `segment ${index}`);
    }
    near(rebuilt.camera.projectionMatrix.toArray(), camera.projectionMatrix.toArray());
    near(rebuilt.camera.matrixWorld.toArray(), camera.matrixWorld.toArray());
  }
  const again = await createCompletePoseExport({ mannequin, pose, restTransforms, views: [view], activeView: 0, renderer, proceduralSource });
  assert.equal(again.validation.poseHash.value, data.validation.poseHash.value);
  mannequin.bones.head.position.x = NaN;
  await assert.rejects(createCompletePoseExport({ mannequin, pose, restTransforms, views: [view], activeView: 0, renderer, proceduralSource }), /non-finite/);
});
