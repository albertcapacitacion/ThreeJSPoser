import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { JOINTS, JOINT_MAP, createPose, limitAngles, validatePose } from './rig.js';
import { createHistory } from './history.js';
import { createMannequin } from './mannequin.js';

const $ = id => document.getElementById(id);
const radians = THREE.MathUtils.degToRad, degrees = THREE.MathUtils.radToDeg;
const viewport = $('viewport');
let pose = createPose(), selected = 'leftShoulder';
const history = createHistory(pose);
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
} catch {
  $('boot-message').textContent = 'WebGL could not start. Enable hardware acceleration in Chrome and reload.';
  throw new Error('WebGL is unavailable.');
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.domElement.setAttribute('aria-label', 'Interactive segmented mannequin. Use the joint controls for keyboard editing.');
viewport.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9eee8);
scene.fog = new THREE.Fog(0xe9eee8, 7, 18);
const camera = new THREE.PerspectiveCamera(36, 1, .01, 80);
camera.position.set(2.25, 1.55, 4.3);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, .99, 0);
orbit.minDistance = .12;
orbit.maxDistance = 12;
orbit.maxPolarAngle = Math.PI * .94;
orbit.enableDamping = false;
const hemi = new THREE.HemisphereLight(0xffffff, 0xa5b9a2, 2.3);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xfff5df, 3.2);
key.position.set(-2.7, 5, 3.8);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -2.5, right: 2.5, top: 3, bottom: -2.5, near: .1, far: 15 });
key.shadow.normalBias = .025;
scene.add(key);
const fill = new THREE.DirectionalLight(0xd7eaff, 1.4);
fill.position.set(3, 2, -2);
scene.add(fill);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0xe9eee8, roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -.012;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(12, 60, 0xa5b5a6, 0xb5c2b4);
grid.position.y = -.009;
grid.material.transparent = true;
grid.material.opacity = .28;
scene.add(grid);
const mannequin = createMannequin(scene);
mannequin.sync(pose);

const transform = new TransformControls(camera, renderer.domElement);
transform.setMode('rotate');
transform.setSpace('local');
transform.setSize(.86);
transform.setColors(0xee5d60, 0x46af77, 0x508bff, 0xffc55b);
transform.showE = false;
scene.add(transform.getHelper());
// A subtle sphere makes the otherwise invisible free-rotation area discoverable.
const orb = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), new THREE.MeshBasicMaterial({
  color: 0x6c9d91, transparent: true, opacity: .045, depthWrite: false, depthTest: false,
}));
orb.renderOrder = 1;
scene.add(orb);

const selector = $('joint-select');
for (const group of [...new Set(JOINTS.map(j => j.group))]) {
  const optgroup = document.createElement('optgroup');
  optgroup.label = group;
  for (const joint of JOINTS.filter(j => j.group === group)) {
    const option = new Option(joint.label, joint.id);
    optgroup.append(option);
  }
  selector.append(optgroup);
}
const axisInputs = ['X', 'Y', 'Z'].map((axis, index) => {
  const row = document.createElement('div');
  row.className = 'angle-row';
  row.dataset.axis = index;
  row.innerHTML = `<label class="axis-badge" for="angle-${axis}">${axis}</label><input type="range" id="range-${axis}" aria-label="${axis} rotation slider" step="1"><input type="number" id="angle-${axis}" aria-label="${axis} rotation in degrees" step="1">`;
  $('angle-controls').append(row);
  const range = row.querySelector('[type=range]'), number = row.querySelector('[type=number]');
  const apply = input => {
    if (input.value.trim() === '') return;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    const angles = [...pose.rotations[selected]];
    angles[index] = Math.max(-180, Math.min(180, value));
    pose.rotations[selected] = limitAngles(selected, angles, pose.limits);
    mannequin.sync(pose);
    syncAngles(input === number ? number : null);
    status(`${JOINT_MAP[selected].label} updated`);
  };
  range.addEventListener('input', () => apply(range));
  range.addEventListener('change', commit);
  number.addEventListener('input', () => apply(number));
  number.addEventListener('change', () => { syncAngles(); commit(); });
  return { range, number };
});

function status(message, kind = '') {
  $('status').textContent = message;
  $('status').className = kind;
}
function syncAngles(except = null) {
  axisInputs.forEach(({ range, number }, axis) => {
    const limits = pose.limits ? JOINT_MAP[selected].limits[axis] : [-180, 180];
    for (const input of [range, number]) {
      input.min = limits[0]; input.max = limits[1];
      input.disabled = limits[0] === limits[1];
      input.title = `${['X', 'Y', 'Z'][axis]}: ${limits[0]}° to ${limits[1]}°`;
      if (input !== except) input.value = Math.round(pose.rotations[selected][axis] * 10) / 10;
    }
  });
}
function syncControls() {
  $('limits').checked = pose.limits;
  $('limit-status').textContent = pose.limits ? 'Restricted joint axes' : 'Full rotation for extreme poses';
  $('undo').disabled = !history.canUndo;
  $('redo').disabled = !history.canRedo;
  const limits = JOINT_MAP[selected].limits;
  transform.showX = !pose.limits || limits[0][0] !== limits[0][1];
  transform.showY = !pose.limits || limits[1][0] !== limits[1][1];
  transform.showZ = !pose.limits || limits[2][0] !== limits[2][1];
  // A hinge still accepts free dragging, but the resulting pose is constrained.
  syncAngles();
}
function commit() { history.push(pose); syncControls(); }
function selectJoint(id) {
  if (!JOINT_MAP[id] || transform.dragging) return;
  selected = id;
  selector.value = id;
  mannequin.highlight(id);
  transform.attach(mannequin.bones[id]);
  $('joint-region').textContent = JOINT_MAP[id].group;
  $('joint-description').textContent = /Knee|Elbow|Toes|[234]$/.test(id)
    ? pose.limits
      ? 'Hinge control is on. Turn off Hinge control & joint limits below for free rotation.'
      : 'Free rotation is on. Turn Hinge control & joint limits back on to restrict this joint.'
    : 'Drag an axis ring for precise rotation, or drag inside the orb to rotate freely.';
  syncControls();
  status(`Selected ${JOINT_MAP[id].label.toLowerCase()}`);
}
selector.addEventListener('change', () => selectJoint(selector.value));

let dragStart = null, cancelling = false;
transform.addEventListener('dragging-changed', event => { orbit.enabled = !event.value; });
transform.addEventListener('mouseDown', () => { dragStart = structuredClone(pose); });
transform.addEventListener('objectChange', () => {
  if (cancelling) return;
  const rotation = mannequin.bones[selected].rotation;
  const raw = [rotation.x, rotation.y, rotation.z].map(degrees);
  const constrained = limitAngles(selected, raw, pose.limits);
  const limited = raw.some((n, i) => Math.abs(n - constrained[i]) > .01);
  pose.rotations[selected] = constrained;
  mannequin.sync(pose);
  syncAngles();
  status(limited ? 'Joint limit reached' : `Rotating ${JOINT_MAP[selected].label.toLowerCase()}`, limited ? 'limited' : '');
});
transform.addEventListener('mouseUp', () => {
  if (dragStart && !cancelling) commit();
  dragStart = null;
});

// Give visible markers priority over the orb, so nearby joints stay selectable.
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
function hits(event, objects) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(objects, false).filter(hit => hit.object.visible);
}
let clickStart = null;
renderer.domElement.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const marker = hits(event, mannequin.markers)[0];
  const bodyPart = marker || hits(event, mannequin.pickables)[0];
  if (bodyPart && bodyPart.object.userData.jointId !== selected && !transform.dragging) {
    selectJoint(bodyPart.object.userData.jointId);
    event.stopImmediatePropagation();
    clickStart = null;
    return;
  }
  clickStart = { x: event.clientX, y: event.clientY, gizmo: transform.axis !== null };
}, true);
renderer.domElement.addEventListener('pointerup', event => {
  if (!clickStart || event.button !== 0) return;
  const start = clickStart;
  clickStart = null;
  if (start.gizmo || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
  const hit = hits(event, mannequin.pickables)[0];
  if (hit) selectJoint(hit.object.userData.jointId);
});

function restore(value, message) {
  if (!value) return;
  pose = value;
  mannequin.sync(pose);
  syncControls();
  status(message);
}
$('undo').addEventListener('click', () => restore(history.undo(), 'Undid pose change'));
$('redo').addEventListener('click', () => restore(history.redo(), 'Redid pose change'));
$('limits').addEventListener('change', () => {
  pose.limits = $('limits').checked;
  for (const j of JOINTS) pose.rotations[j.id] = limitAngles(j.id, pose.rotations[j.id], pose.limits);
  mannequin.sync(pose); syncControls();
  $('joint-description').textContent = /Knee|Elbow|Toes|[234]$/.test(selected)
    ? pose.limits
      ? 'Hinge control is on. Turn off Hinge control & joint limits below for free rotation.'
      : 'Free rotation is on. Turn Hinge control & joint limits back on to restrict this joint.'
    : $('joint-description').textContent;
  commit();
  status(pose.limits ? 'Joint limits enabled · existing angles adjusted to their ranges' : 'Joint limits disabled');
});
$('reset-joint').addEventListener('click', () => {
  pose.rotations[selected] = [...JOINT_MAP[selected].rest];
  mannequin.sync(pose); commit(); status('Selected joint reset');
});
$('reset-pose').addEventListener('click', () => {
  const limits = pose.limits;
  pose = createPose(); pose.limits = limits;
  mannequin.sync(pose); commit(); status('Whole pose reset · Undo is available');
});
$('show-joints').addEventListener('change', () => mannequin.setMarkersVisible($('show-joints').checked));

function focusJoint(id = selected) {
  const target = mannequin.bones[id].getWorldPosition(new THREE.Vector3());
  const isHand = /Wrist|Thumb|Index|Middle|Ring|Little/.test(id);
  const distance = isHand ? .78 : .95;
  const direction = isHand
    ? new THREE.Vector3(id.startsWith('left') ? .48 : -.48, .16, 1).normalize()
    : camera.position.clone().sub(orbit.target).normalize();
  orbit.target.copy(target);
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.near = .005;
  camera.updateProjectionMatrix();
  orbit.update();
  status(`Focused ${JOINT_MAP[id].label.toLowerCase()}`);
}
function fitBody() {
  const box = new THREE.Box3().setFromObject(mannequin.root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const vertical = size.y / (2 * Math.tan(radians(camera.fov / 2)));
  const horizontal = Math.max(size.x, size.z) / (2 * Math.tan(radians(camera.fov / 2)) * camera.aspect);
  const distance = Math.max(vertical, horizontal) * 1.4;
  orbit.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(.3, .13, 1).normalize().multiplyScalar(distance));
  orbit.update();
  status('Whole mannequin framed');
}
$('focus').addEventListener('click', () => focusJoint());
$('fit').addEventListener('click', fitBody);
$('focus-hand').addEventListener('click', () => { const id = `${$('hand-side').value}Wrist`; selectJoint(id); focusJoint(id); });
for (const button of document.querySelectorAll('[data-hand]')) button.addEventListener('click', () => {
  const side = $('hand-side').value;
  const preset = button.dataset.hand;
  for (const j of JOINTS.filter(j => j.id.startsWith(side) && /Thumb|Index|Middle|Ring|Little/.test(j.id))) {
    const thumb = j.id.includes('Thumb'), index = Number(j.id.at(-1));
    let angles = [...j.rest];
    if (preset === 'relaxed') angles[0] = thumb ? 12 : [0, 18, 25, 12][index];
    if (preset === 'fist') angles[0] = thumb ? [0, 35, 45, 55][index] : [0, 75, 90, 65][index];
    pose.rotations[j.id] = limitAngles(j.id, angles, pose.limits);
  }
  mannequin.sync(pose); commit(); status(`${side === 'left' ? 'Left' : 'Right'} hand: ${preset}`);
});

$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(pose, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `threejs-pose-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('Pose downloaded · keep the file to reopen it later');
});
$('import').addEventListener('click', () => $('pose-file').click());
$('pose-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 100_000) throw new Error('Pose files must be smaller than 100 KB.');
    const next = validatePose(JSON.parse(await file.text()));
    pose = next; mannequin.sync(pose); commit();
    status('Pose opened · Undo restores the previous pose');
  } catch (error) { status(`Pose not opened: ${error.message}`, 'error'); }
});

window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && transform.dragging && dragStart) {
    cancelling = true;
    transform.reset();
    pose = dragStart;
    dragStart = null;
    mannequin.sync(pose);
    transform.dragging = false;
    transform.axis = null;
    orbit.enabled = true;
    cancelling = false;
    syncControls();
    status('Rotation cancelled');
    return;
  }
  if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    restore(event.shiftKey ? history.redo() : history.undo(), event.shiftKey ? 'Redid pose change' : 'Undid pose change');
  } else if (!transform.dragging && event.key.toLowerCase() === 'f') focusJoint();
  else if (!transform.dragging && event.key === 'Home') { event.preventDefault(); fitBody(); }
});
function resize() {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
}
new ResizeObserver(resize).observe(viewport);
renderer.domElement.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  status('Graphics context lost. Save your pose, then reload to restore the viewport.', 'error');
});
renderer.domElement.addEventListener('webglcontextrestored', () => status('Graphics context restored'));
selectJoint(selected);
resize();
fitBody();
$('boot-message').remove();
status('Ready · select a joint to begin');
const guideInverseCamera = new THREE.Quaternion();
const guideVector = new THREE.Vector3();
const guideAxes = [
  ['x', new THREE.Vector3(1, 0, 0)],
  ['y', new THREE.Vector3(0, 1, 0)],
  ['z', new THREE.Vector3(0, 0, 1)],
].map(([name, direction]) => ({
  direction,
  line: $(`guide-line-${name}`),
  positive: $(`guide-mark-${name}`),
  negative: $(`guide-negative-${name}`),
}));
function syncAxisGuide() {
  guideInverseCamera.copy(camera.quaternion).invert();
  for (const axis of guideAxes) {
    guideVector.copy(axis.direction).applyQuaternion(guideInverseCamera);
    const x = 50 + guideVector.x * 29;
    const y = 50 - guideVector.y * 29;
    const nx = 100 - x;
    const ny = 100 - y;
    axis.line.setAttribute('x1', nx);
    axis.line.setAttribute('y1', ny);
    axis.line.setAttribute('x2', x);
    axis.line.setAttribute('y2', y);
    axis.positive.setAttribute('transform', `translate(${x} ${y})`);
    axis.negative.setAttribute('cx', nx);
    axis.negative.setAttribute('cy', ny);
    const text = axis.positive.querySelector('text');
    text.setAttribute('x', guideVector.x < -.15 ? -8 : 8);
    text.setAttribute('y', guideVector.y > .15 ? -8 : 10);
    text.setAttribute('text-anchor', guideVector.x < -.15 ? 'end' : 'start');
    const opacity = .45 + Math.abs(guideVector.z) * .55;
    axis.line.style.opacity = opacity;
    axis.positive.style.opacity = opacity;
    axis.negative.style.opacity = opacity;
  }
}
renderer.setAnimationLoop(() => {
  const worldPosition = mannequin.bones[selected].getWorldPosition(new THREE.Vector3());
  orb.position.copy(worldPosition);
  // Match the gizmo's world-space radius, independent of camera zoom.
  const factor = camera.position.distanceTo(worldPosition) * Math.min(1.9 * Math.tan(Math.PI * camera.fov / 360) / camera.zoom, 7);
  orb.scale.setScalar(factor * transform.size / 7 * .5);
  syncAxisGuide();
  renderer.render(scene, camera);
});
