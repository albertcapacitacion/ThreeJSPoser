import * as THREE from 'three';

// Exact installed release, checked against package.json by the reconstruction test.
export const THREE_VERSION = '0.186.1';

function transform(node) {
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  node.matrixWorld.decompose(position, quaternion, scale);
  const radians = [node.rotation.x, node.rotation.y, node.rotation.z];
  return {
    local: {
      position: node.position.toArray(), eulerRadians: radians,
      eulerDegrees: radians.map(THREE.MathUtils.radToDeg), rotationOrder: node.rotation.order,
      quaternion: node.quaternion.toArray(), scale: node.scale.toArray(), matrix: node.matrix.toArray(),
    },
    world: { position: position.toArray(), quaternion: quaternion.toArray(), scale: scale.toArray(), matrix: node.matrixWorld.toArray() },
  };
}

// Includes every ancestor and intermediate node, but not editor marker subtrees.
function hierarchy(mannequin) {
  const nodes = [], markers = new Set(mannequin.markers);
  for (let parent = mannequin.root.parent; parent; parent = parent.parent) nodes.unshift(parent);
  const visit = node => {
    if (markers.has(node)) return;
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(mannequin.root);
  return nodes;
}

export function captureRigTransforms(mannequin) {
  mannequin.root.updateWorldMatrix(true, false);
  mannequin.root.updateMatrixWorld(true);
  return Object.fromEntries(hierarchy(mannequin).map((node, index) => [`node-${index}`, transform(node)]));
}

function captureCamera({ camera, target, name, viewport, lastVisibleViewport, projectionSize }, renderer) {
  // Capture optical state without changing framing or controls.
  camera.updateWorldMatrix(true, false);
  const copy = camera.clone();
  copy.matrixWorld.copy(camera.matrixWorld);
  const local = transform(copy).local;
  const world = transform(copy).world;
  const bounds = camera.isOrthographicCamera
    ? { left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom } : null;
  const pixelRatio = renderer.getPixelRatio();
  const visible = !!(viewport.width && viewport.height);
  // Hidden cameras can be reframed after a resize without ever becoming visible.
  const renderSize = visible ? viewport : projectionSize ?? lastVisibleViewport;
  return {
    name, type: camera.isOrthographicCamera ? 'orthographic' : 'perspective',
    position: world.position, quaternion: world.quaternion,
    rotation: { radians: local.eulerRadians, degrees: local.eulerDegrees, order: local.rotationOrder },
    local, up: camera.up.toArray(), lookAtTarget: target.toArray(), orbitControlsTarget: target.toArray(),
    framingOffset: new THREE.Vector3().fromArray(world.position).sub(target).toArray(),
    fov: camera.isPerspectiveCamera ? camera.fov : null, orthographicBounds: bounds,
    aspect: bounds ? (bounds.right - bounds.left) / (bounds.top - bounds.bottom) : camera.aspect,
    near: camera.near, far: camera.far, zoom: camera.zoom,
    filmGauge: camera.filmGauge ?? null, filmOffset: camera.filmOffset ?? null, view: camera.view ? { ...camera.view } : null,
    projectionMatrix: camera.projectionMatrix.toArray(), worldMatrix: world.matrix,
    viewport: { ...viewport, origin: 'bottom-left', units: 'CSS pixels', visible },
    lastVisibleViewport: visible ? viewport : lastVisibleViewport,
    renderResolution: { width: Math.floor(renderSize.width * pixelRatio), height: Math.floor(renderSize.height * pixelRatio) },
    canvasResolution: renderer.getDrawingBufferSize(new THREE.Vector2()).toArray(), pixelRatio,
  };
}

function allFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return !value || typeof value !== 'object' || Object.values(value).every(allFinite);
}

export async function createCompletePoseExport({ mannequin, pose, restTransforms, views, activeView, renderer, proceduralSource }) {
  // Capture everything synchronously before hashing; an asynchronous download cannot mix poses.
  const current = captureRigTransforms(mannequin);
  const objects = hierarchy(mannequin), ids = new Map(objects.map((node, index) => [node, `node-${index}`]));
  const jointNames = new Map(Object.entries(mannequin.bones).map(([name, node]) => [node, name]));
  const nodes = objects.map(node => ({
    id: ids.get(node), name: node.name, type: node.type,
    parent: ids.get(node.parent) ?? null, joint: jointNames.get(node) ?? null,
    local: current[ids.get(node)].local,
  }));
  const joints = objects.filter(node => jointNames.has(node)).map(node => {
    let parent = node.parent;
    while (parent && !jointNames.has(parent)) parent = parent.parent;
    return { name: jointNames.get(node), node: ids.get(node), parent: jointNames.get(parent) ?? null, local: current[ids.get(node)].local };
  });
  const geometries = new Map(), materials = new Map();
  const segments = objects.filter(node => node.isMesh).map((mesh, index) => {
    if (!['SphereGeometry', 'CapsuleGeometry'].includes(mesh.geometry.type) || Array.isArray(mesh.material)) {
      throw new Error(`Unsupported geometry or material on ${mesh.name || ids.get(mesh)}; export needs an updated geometry serializer.`);
    }
    geometries.set(mesh.geometry.uuid, mesh.geometry.toJSON());
    materials.set(mesh.material.uuid, mesh.material.toJSON());
    return {
      name: mesh.name || `${mesh.userData.jointId}-segment-${index}`, node: ids.get(mesh),
      parent: ids.get(mesh.parent), joint: mesh.userData.jointId,
      geometry: mesh.geometry.uuid, geometryType: mesh.geometry.type,
      material: mesh.material.uuid, local: current[ids.get(mesh)].local,
      // Construction uses untouched, centered primitives; orientation/offset is on the mesh.
      geometrySpaceMatrix: new THREE.Matrix4().toArray(), customShapeParameters: null,
      visible: mesh.visible, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow,
    };
  });
  const front = captureCamera(views[0], renderer);
  const result = {
    formatVersion: '1.0',
    rig: { identifier: pose.rig, version: pose.version, type: 'Object3D hierarchy (Group joints; no skinning)',
      root: ids.get(mannequin.root), nodes, joints, traversalOrder: nodes.map(node => node.id) },
    coordinateSystem: {
      threeVersion: THREE_VERSION, threeRevision: THREE.REVISION, worldUp: [0, 1, 0], forward: [0, 0, 1],
      anatomicalLeft: [1, 0, 0], anatomicalRight: [-1, 0, 0], handedness: 'right-handed',
      worldUnits: 'metres', metresPerUnit: 1, eulerOrder: 'per-node rotationOrder (XYZ in this rig)',
      angleUnits: { legacyRotations: 'degrees', eulerRadians: 'radians', eulerDegrees: 'degrees' },
      quaternionOrder: ['x', 'y', 'z', 'w'], rotationsRelativeTo: 'parent', matrixLayout: 'column-major',
    },
    restPose: { description: 'Original initialized standing arms-down pose', transforms: structuredClone(restTransforms) },
    pose: { ...structuredClone(pose), transforms: current },
    camera: { front, activeView: views[activeView].name,
      active: activeView === 0 ? null : captureCamera(views[activeView], renderer) },
    geometry: { segments, resources: [...geometries.values()], materials: [...materials.values()],
      encoding: 'Three.js primitive geometry and material JSON; resources shared by UUID',
      proceduralSource: structuredClone(proceduralSource),
      requiredCompanionAssets: [], excluded: ['editor joint markers', 'gizmos', 'floor', 'grid', 'lights', 'background', 'fog'] },
    validation: {},
  };
  const validIds = new Set(nodes.map(node => node.id));
  const validJoints = new Set(joints.map(joint => joint.name));
  result.validation = {
    jointCount: joints.length, bodySegmentCount: segments.length,
    rootWorldTransform: current[result.rig.root].world, cameraProjectionType: front.type,
    everyJointHasValidParent: joints.every(joint => joint.parent === null || validJoints.has(joint.parent)),
    everyNodeHasValidParent: nodes.every(node => node.parent === null || validIds.has(node.parent)),
    allTransformValuesFinite: allFinite([current, restTransforms, result.camera]),
    missingOrUnsupportedData: nodes.filter(node => !restTransforms[node.id]).map(node => `Missing rest transform: ${node.id}`),
  };
  if (!result.validation.allTransformValuesFinite || result.validation.missingOrUnsupportedData.length) {
    throw new Error('Incomplete or non-finite transforms; no pose file was generated.');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(result.pose)));
  result.validation.poseHash = { algorithm: 'SHA-256', input: 'UTF-8 JSON.stringify(pose)',
    value: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
  return result;
}
