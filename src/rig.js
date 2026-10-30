// Metres, Y up, +Z forward. Anatomical left is +X.
// These are conservative artistic ranges, not a medical anatomy model.
const joints = [];
const add = (id, label, parent, offset, limits, rest = [0, 0, 0], group = 'Body') => {
  joints.push({ id, label, parent, offset, limits, rest, group });
};
add('pelvis', 'Pelvis / body', null, [0, 1, 0], [[-40, 40], [-65, 65], [-30, 30]]);
add('lumbar', 'Lower spine', 'pelvis', [0, .105, 0], [[-22, 32], [-18, 18], [-18, 18]]);
add('spine', 'Middle spine', 'lumbar', [0, .12, 0], [[-20, 28], [-20, 20], [-20, 20]]);
add('chest', 'Chest / upper spine', 'spine', [0, .13, 0], [[-18, 22], [-22, 22], [-18, 18]]);
add('neck', 'Neck', 'chest', [0, .205, 0], [[-30, 35], [-45, 45], [-25, 25]]);
add('head', 'Head', 'neck', [0, .105, 0], [[-20, 25], [-35, 35], [-20, 20]]);

for (const [side, s] of [['left', 1], ['right', -1]]) {
  const label = side === 'left' ? 'Left' : 'Right';
  const arm = `${label} arm`, leg = `${label} leg`, hand = `${label} hand`;
  const mirroredZ = ([min, max]) => s === 1 ? [min, max] : [-max, -min];
  add(`${side}Clavicle`, `${label} clavicle`, 'chest', [s * .055, .12, 0],
    [[-20, 20], [-25, 25], [-20, 20]], [0, 0, 0], arm);
  add(`${side}Shoulder`, `${label} shoulder`, `${side}Clavicle`, [s * .135, 0, 0],
    [[-165, 55], [-80, 80], mirroredZ([-30, 165])], [0, 0, s * 8], arm);
  add(`${side}Elbow`, `${label} elbow`, `${side}Shoulder`, [0, -.29, 0],
    [[-145, 0], [0, 0], [0, 0]], [-6, 0, 0], arm);
  add(`${side}Forearm`, `${label} forearm twist`, `${side}Elbow`, [0, -.13, 0],
    [[0, 0], [-80, 80], [0, 0]], [0, 0, 0], arm);
  add(`${side}Wrist`, `${label} wrist`, `${side}Forearm`, [0, -.13, 0],
    [[-65, 65], [0, 0], [-25, 25]], [0, 0, 0], hand);

  const fingers = [
    ['Index', -.026, .039, .026, .019], ['Middle', -.008, .044, .029, .021],
    ['Ring', .011, .041, .027, .019], ['Little', .029, .032, .021, .017],
  ];
  for (const [name, x, a, b] of fingers) {
    add(`${side}${name}1`, `${label} ${name.toLowerCase()} · base`, `${side}Wrist`,
      [s * x, -.085, 0], [[-8, 90], [0, 0], [-14, 14]], [0, 0, 0], hand);
    add(`${side}${name}2`, `${label} ${name.toLowerCase()} · middle`, `${side}${name}1`,
      [0, -a, 0], [[0, 105], [0, 0], [0, 0]], [0, 0, 0], hand);
    add(`${side}${name}3`, `${label} ${name.toLowerCase()} · tip`, `${side}${name}2`,
      [0, -b, 0], [[0, 80], [0, 0], [0, 0]], [0, 0, 0], hand);
  }
  add(`${side}Thumb1`, `${label} thumb · base`, `${side}Wrist`, [-s * .035, -.027, .014],
    [[-30, 50], [-45, 45], [-45, 45]], [0, 0, -s * 32], hand);
  add(`${side}Thumb2`, `${label} thumb · middle`, `${side}Thumb1`, [0, -.035, 0],
    [[-10, 65], [-15, 15], [-15, 15]], [0, 0, 0], hand);
  add(`${side}Thumb3`, `${label} thumb · tip`, `${side}Thumb2`, [0, -.028, 0],
    [[0, 80], [0, 0], [0, 0]], [0, 0, 0], hand);

  add(`${side}Hip`, `${label} hip`, 'pelvis', [s * .105, -.055, 0],
    [[-120, 35], [-40, 40], mirroredZ([-25, 65])], [0, 0, 0], leg);
  add(`${side}Knee`, `${label} knee`, `${side}Hip`, [0, -.43, 0],
    [[0, 150], [0, 0], [0, 0]], [0, 0, 0], leg);
  add(`${side}Ankle`, `${label} ankle`, `${side}Knee`, [0, -.43, 0],
    [[-35, 25], [-12, 12], [-18, 18]], [0, 0, 0], leg);
  add(`${side}Toes`, `${label} toes`, `${side}Ankle`, [0, -.025, .115],
    [[-40, 45], [0, 0], [0, 0]], [0, 0, 0], leg);
}
export const JOINTS = joints;
export const JOINT_MAP = Object.fromEntries(joints.map(j => [j.id, j]));
export const FINGER_LENGTHS = { Index: [.039, .026, .019], Middle: [.044, .029, .021], Ring: [.041, .027, .019], Little: [.032, .021, .017], Thumb: [.035, .028, .023] };

export function limitAngles(id, angles, enabled) {
  if (!enabled) return [...angles];
  return angles.map((n, axis) => Math.max(JOINT_MAP[id].limits[axis][0], Math.min(JOINT_MAP[id].limits[axis][1], n)));
}

export function createPose() {
  return { version: 1, rig: 'threejs-poser-segmented-v1', limits: true,
    rotations: Object.fromEntries(joints.map(j => [j.id, [...j.rest]])) };
}

export function validatePose(value) {
  if (!value || value.version !== 1 || value.rig !== 'threejs-poser-segmented-v1' || typeof value.limits !== 'boolean') {
    throw new Error('This file is not a compatible ThreeJSPoser pose.');
  }
  const rotations = value.rotations;
  if (!rotations || Object.keys(rotations).length !== joints.length) throw new Error('The pose has missing or unknown joints.');
  const result = createPose();
  result.limits = value.limits;
  for (const j of joints) {
    const a = rotations[j.id];
    if (!Array.isArray(a) || a.length !== 3 || !a.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 360)) {
      throw new Error(`Invalid angles for ${j.label}.`);
    }
    result.rotations[j.id] = limitAngles(j.id, a, result.limits);
  }
  return result;
}
