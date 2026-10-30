import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOINTS, JOINT_MAP, createPose, limitAngles, validatePose } from '../src/rig.js';
import { createHistory } from '../src/history.js';

test('the entire rig is connected, uniquely named and valid in its rest pose', () => {
  assert.equal(JOINTS.length, 54);
  const seen = new Set();
  for (const j of JOINTS) {
    assert.ok(!seen.has(j.id));
    if (j.parent) assert.ok(seen.has(j.parent), `Missing parent of ${j.id}`);
    assert.equal(j.limits.length, 3);
    assert.deepEqual(limitAngles(j.id, j.rest, true), j.rest);
    seen.add(j.id);
  }
});

test('elbows and knees cannot hyperextend or twist with joint limits enabled', () => {
  assert.deepEqual(limitAngles('leftElbow', [90, 120, -40], true), [0, 0, 0]);
  assert.deepEqual(limitAngles('rightKnee', [-90, 60, 60], true), [0, 0, 0]);
  assert.deepEqual(limitAngles('leftKnee', [180, 50, 20], true), [150, 0, 0]);
  assert.deepEqual(limitAngles('leftElbow', [90, 120, -40], false), [90, 120, -40]);
});

test('leg directions match Y-up anatomy and left/right limits are mirrored', () => {
  assert.deepEqual(JOINT_MAP.leftHip.limits[0], [-120, 35]);
  for (const name of ['Clavicle', 'Shoulder', 'Hip']) {
    const [min, max] = JOINT_MAP[`left${name}`].limits[2];
    assert.deepEqual(JOINT_MAP[`right${name}`].limits[2], [-max, -min]);
  }
});

test('pose file round trip preserves all joint angles without sharing mutable state', () => {
  const pose = createPose();
  pose.rotations.leftIndex2[0] = 65;
  const loaded = validatePose(JSON.parse(JSON.stringify(pose)));
  assert.deepEqual(loaded, pose);
  loaded.rotations.leftIndex2[0] = 25;
  assert.equal(pose.rotations.leftIndex2[0], 65);
});

test('imports reject foreign rigs, missing bones, invalid numbers and unknown joints', () => {
  const mutations = [
    p => { p.rig = 'other'; }, p => { delete p.rotations.head; },
    p => { p.rotations.head = [null, 0, 0]; }, p => { p.rotations.head = [Infinity, 0, 0]; },
    p => { p.rotations.head = [4000, 0, 0]; }, p => { p.rotations.unknown = [0, 0, 0]; },
  ];
  for (const mutate of mutations) { const p = createPose(); mutate(p); assert.throws(() => validatePose(p)); }
});

test('imports apply enabled limits but preserve unrestricted poses', () => {
  const pose = createPose();
  pose.rotations.leftKnee = [-50, 30, 20];
  assert.deepEqual(validatePose(pose).rotations.leftKnee, [0, 0, 0]);
  pose.limits = false;
  assert.deepEqual(validatePose(pose).rotations.leftKnee, [-50, 30, 20]);
});

test('undo snapshots are isolated, redo is removed after a new edit', () => {
  const pose = createPose(), history = createHistory(pose);
  pose.rotations.head[0] = 12; history.push(pose);
  pose.rotations.head[0] = 20;
  assert.equal(history.undo().rotations.head[0], 0);
  assert.equal(history.redo().rotations.head[0], 12);
  history.undo();
  history.push(pose);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo().rotations.head[0], 0);
});
