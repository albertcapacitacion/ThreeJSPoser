import * as THREE from 'three';

// Stable IDs; changing these assignments requires a new palette version.
export const PALETTE_VERSION = 1;
export const PALETTE = [
  ['background', [0, 0, 0]], ['head', [255, 255, 0]], ['torso', [128, 128, 128]],
  ['leftUpperArm', [255, 0, 0]], ['leftForearm', [128, 0, 0]],
  ['rightUpperArm', [0, 255, 0]], ['rightForearm', [0, 128, 0]],
  ['leftUpperLeg', [0, 0, 255]], ['leftLowerLeg', [0, 0, 128]],
  ['rightUpperLeg', [255, 0, 255]], ['rightLowerLeg', [128, 0, 128]],
  ['leftHand', [0, 255, 255]], ['rightHand', [0, 128, 128]],
  ['leftFoot', [255, 128, 0]], ['rightFoot', [128, 64, 0]],
].map(([name, rgb], id) => ({ id, name, rgb }));

export function segmentId(joint) {
  if (joint === 'head') return 1;
  for (const [side, arm, forearm, upperLeg, lowerLeg, hand, foot] of [
    ['left', 3, 4, 7, 8, 11, 13], ['right', 5, 6, 9, 10, 12, 14],
  ]) {
    if (joint === `${side}Shoulder`) return arm;
    if (joint === `${side}Elbow` || joint === `${side}Forearm`) return forearm;
    if (joint === `${side}Hip`) return upperLeg;
    if (joint === `${side}Knee`) return lowerLeg;
    if (joint === `${side}Ankle` || joint === `${side}Toes`) return foot;
    if (joint.startsWith(side) && /Wrist|Thumb|Index|Middle|Ring|Little/.test(joint)) return hand;
  }
  if (['pelvis', 'lumbar', 'spine', 'chest', 'neck', 'leftClavicle', 'rightClavicle'].includes(joint)) return 2;
  throw new Error(`Unmapped segmentation joint: ${joint}`);
}

export const OCCLUSION = {
  definition: 'body-part surface visibility along the exact projected landmark ray, not literal visibility of an internal joint point',
  method: 'nearest front-facing triangle within camera clipping planes; own anatomical segment and immediate parent segment support joint sockets',
  toleranceMetres: 0.0001,
  limitations: 'A visible supporting surface does not mean an internal joint or approximate facial anchor itself is visible. No supporting surface or a near-coincident foreign surface is unknown. No human-image visibility is inferred.',
};

export function classifyOcclusion(point, meshes, camera, supportIds) {
  if (!point) return { status: 'unavailable', occluded: null };
  if (!point.inFrame) return { status: 'out-of-frame', occluded: null };
  const ray = new THREE.Raycaster();
  const world = new THREE.Vector3(...point.world), ndc = world.clone().project(camera);
  ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
  const hits = ray.intersectObjects(meshes, false).filter(hit => {
    const depth = -hit.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
    return depth >= camera.near && depth <= camera.far;
  });
  const first = hits[0];
  if (!first) return { status: 'unknown', occluded: null, reason: 'no-surface-on-ray' };
  const depth = -first.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
  const id = segmentId(first.object.userData.jointId);
  if (supportIds.includes(id)) return { status: 'visible', occluded: false, surfaceJoint: first.object.userData.jointId };
  if (depth < point.distance - OCCLUSION.toleranceMetres) {
    return { status: 'occluded', occluded: true, occluderJoint: first.object.userData.jointId,
      occluderSegmentId: id, surfaceDepthMetres: depth };
  }
  return { status: 'unknown', occluded: null, reason: 'no-unambiguous-supporting-surface' };
}

const vertexShader = 'varying float distanceToCamera; void main(){ vec4 p=modelViewMatrix*vec4(position,1.0); distanceToCamera=-p.z; gl_Position=projectionMatrix*p; }';
const toCanvas = (bytes, width, height) => {
  const result = Object.assign(document.createElement('canvas'), { width, height });
  result.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes), width, height), 0, 0);
  return result;
};

// Unmultisampled data passes: no lighting, color conversion, blending or tone mapping.
// The target samples the same pixel centers for IDs, silhouette and precise depth.
export function renderDataMaps(renderer, scene, meshes, camera, width, height, range) {
  const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, samples: 0 });
  target.texture.colorSpace = THREE.NoColorSpace;
  const materials = PALETTE.map(entry => new THREE.ShaderMaterial({
    uniforms: { value: { value: new THREE.Vector3(...entry.rgb).divideScalar(255) } }, vertexShader,
    fragmentShader: 'uniform vec3 value; void main(){gl_FragColor=vec4(value,1.0);}',
    toneMapped: false, blending: THREE.NoBlending,
  }));
  const precise = new THREE.ShaderMaterial({
    uniforms: { closest: { value: range.near }, farthest: { value: range.far } }, vertexShader,
    fragmentShader: 'uniform float closest; uniform float farthest; varying float distanceToCamera; void main(){ float q=floor(clamp((farthest-distanceToCamera)/(farthest-closest),1.0/65535.0,1.0)*65535.0+0.5); gl_FragColor=vec4(floor(q/256.0)/255.0,mod(q,256.0)/255.0,0.0,1.0); }',
    toneMapped: false, blending: THREE.NoBlending,
  });
  const original = meshes.map(mesh => mesh.material), override = scene.overrideMaterial;
  const previousTarget = renderer.getRenderTarget();
  function read() {
    renderer.render(scene, camera);
    const raw = new Uint8Array(width * height * 4), upright = new Uint8Array(raw.length);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, raw);
    for (let y = 0; y < height; y++) upright.set(raw.subarray(y * width * 4, (y + 1) * width * 4), (height - 1 - y) * width * 4);
    return upright;
  }
  try {
    renderer.setRenderTarget(target); scene.overrideMaterial = null;
    meshes.forEach(mesh => { mesh.material = materials[segmentId(mesh.userData.jointId)]; });
    const ids = read();
    const mask = ids.slice();
    for (let i = 0; i < mask.length; i += 4) {
      const value = ids[i] || ids[i + 1] || ids[i + 2] ? 255 : 0;
      mask[i] = mask[i + 1] = mask[i + 2] = value;
    }
    scene.overrideMaterial = precise;
    const packed = read();
    return { segmentation: toCanvas(ids, width, height), silhouette: toCanvas(mask, width, height),
      depth16: toCanvas(packed, width, height) };
  } finally {
    meshes.forEach((mesh, index) => { mesh.material = original[index]; });
    scene.overrideMaterial = override; renderer.setRenderTarget(previousTarget);
    target.dispose(); precise.dispose(); materials.forEach(material => material.dispose());
  }
}

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

