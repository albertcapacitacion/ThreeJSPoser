// Reference decoder: no dependency on rig.js, mannequin.js, or embedded source.
import * as THREE from 'three';

export function reconstructPose(data, rest = false) {
  const loader = new THREE.ObjectLoader();
  const geometries = loader.parseGeometries(data.geometry.resources, {});
  const materials = loader.parseMaterials(data.geometry.materials, {});
  const segments = new Map(data.geometry.segments.map(segment => [segment.node, segment]));
  const nodes = new Map(), root = new THREE.Group();
  for (const entry of data.rig.nodes) {
    const segment = segments.get(entry.id);
    const node = segment ? new THREE.Mesh(geometries[segment.geometry], materials[segment.material]) : new THREE.Group();
    node.name = entry.name;
    if (segment) {
      node.visible = segment.visible; node.castShadow = segment.castShadow; node.receiveShadow = segment.receiveShadow;
    }
    nodes.set(entry.id, node);
    (entry.parent === null ? root : nodes.get(entry.parent)).add(node);
  }
  function apply(transforms) {
    for (const [id, node] of nodes) {
      const local = transforms[id].local;
      node.rotation.order = local.rotationOrder;
      node.position.fromArray(local.position); node.quaternion.fromArray(local.quaternion); node.scale.fromArray(local.scale);
      // The matrix is authoritative, including transforms not decomposable into TRS.
      node.matrix.fromArray(local.matrix); node.matrixAutoUpdate = false;
    }
    root.updateMatrixWorld(true);
  }
  apply(data.restPose.transforms);
  if (!rest) apply(data.pose.transforms);
  const state = data.camera.front;
  const camera = state.type === 'orthographic'
    ? new THREE.OrthographicCamera(state.orthographicBounds.left, state.orthographicBounds.right,
      state.orthographicBounds.top, state.orthographicBounds.bottom, state.near, state.far)
    : new THREE.PerspectiveCamera(state.fov, state.aspect, state.near, state.far);
  camera.zoom = state.zoom; camera.up.fromArray(state.up);
  if (camera.isPerspectiveCamera) { camera.filmGauge = state.filmGauge; camera.filmOffset = state.filmOffset; }
  camera.view = state.view;
  camera.updateProjectionMatrix();
  camera.matrix.fromArray(state.worldMatrix);
  camera.matrix.decompose(camera.position, camera.quaternion, camera.scale);
  camera.rotation.order = state.rotation.order;
  camera.matrixAutoUpdate = false; camera.updateMatrixWorld(true);
  return { root, nodes, camera, joints: Object.fromEntries(data.rig.joints.map(joint => [joint.name, nodes.get(joint.node)])) };
}
