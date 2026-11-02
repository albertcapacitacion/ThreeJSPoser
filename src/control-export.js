import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FINGER_LENGTHS } from './rig.js';

// COCO-18 ordering and ControlNet OpenPose palette/topology, not rig traversal order.
// Reference: Mikubill/sd-webui-controlnet/annotator/openpose/util.py.
const BODY = ['nose', 'neck', 'rightShoulder', 'rightElbow', 'rightWrist', 'leftShoulder', 'leftElbow', 'leftWrist',
  'rightHip', 'rightKnee', 'rightAnkle', 'leftHip', 'leftKnee', 'leftAnkle', 'rightEye', 'leftEye', 'rightEar', 'leftEar'];
const LINKS = [[1,2],[1,5],[2,3],[3,4],[5,6],[6,7],[1,8],[8,9],[9,10],[1,11],[11,12],[12,13],[1,0],[0,14],[14,16],[0,15],[15,17]];
const COLORS = [[255,0,0],[255,85,0],[255,170,0],[255,255,0],[170,255,0],[85,255,0],[0,255,0],[0,255,85],[0,255,170],
  [0,255,255],[0,170,255],[0,85,255],[0,0,255],[85,0,255],[170,0,255],[255,0,255],[255,0,170],[255,0,85]];
const DEPTH_TOLERANCE = 3;
const $ = id => document.getElementById(id);
const canvas = (width, height) => Object.assign(document.createElement('canvas'), { width, height });
const pixels = c => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;

function landmarks(mannequin) {
  const point = (name, bone = name, offset = [0, 0, 0]) => ({ name,
    world: mannequin.bones[bone].localToWorld(new THREE.Vector3(...offset)).toArray() });
  const body = BODY.map(name => name === 'nose' ? point(name, 'head', [0, .044, .111])
    : mannequin.bones[name] ? point(name) : null);
  const hands = ['left', 'right'].map(side => {
    const points = [point(`${side}Wrist`)];
    for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
      for (let joint = 1; joint <= 3; joint++) points.push(point(`${side}${finger}${joint}`));
      points.push(point(`${side}${finger}Tip`, `${side}${finger}3`, [0, -FINGER_LENGTHS[finger][2], 0]));
    }
    return points;
  });
  return { body, hands };
}

function project(points, camera, width, height) {
  return points.map(point => {
    if (!point) return null;
    const world = new THREE.Vector3(...point.world), ndc = world.clone().project(camera);
    const distance = -world.clone().applyMatrix4(camera.matrixWorldInverse).z;
    return { ...point, x: (ndc.x + 1) * width / 2, y: (1 - ndc.y) * height / 2, distance,
      inFrame: distance >= camera.near && distance <= camera.far && Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 };
  });
}

function drawSkeleton(context, body, hands, width, height) {
  const radius = 4 * Math.min(width, height) / 512;
  const dot = (point, color) => {
    if (!point?.inFrame) return;
    context.fillStyle = color; context.beginPath(); context.arc(Math.floor(point.x), Math.floor(point.y), radius, 0, Math.PI * 2); context.fill();
  };
  LINKS.forEach(([a, b], i) => {
    const p = body[a], q = body[b];
    if (!p?.inFrame || !q?.inFrame) return;
    context.fillStyle = `rgb(${COLORS[i].map(value => Math.floor(value * .6)).join(',')})`;
    context.beginPath();
    context.ellipse((p.x + q.x) / 2, (p.y + q.y) / 2, Math.hypot(p.x - q.x, p.y - q.y) / 2, radius,
      Math.atan2(q.y - p.y, q.x - p.x), 0, Math.PI * 2); context.fill();
  });
  body.forEach((point, i) => dot(point, `rgb(${COLORS[i].join(',')})`));
  for (const hand of hands) {
    for (let finger = 0; finger < 5; finger++) for (let segment = 0; segment < 4; segment++) {
      const end = 1 + finger * 4 + segment, start = segment === 0 ? 0 : end - 1;
      const p = hand[start], q = hand[end];
      if (!p.inFrame || !q.inFrame) continue;
      // HSV hue around the wheel, matching the 20-edge hand convention.
      context.strokeStyle = `hsl(${(finger * 4 + segment) * 18} 100% 50%)`;
      context.lineWidth = radius / 2; context.beginPath(); context.moveTo(p.x, p.y); context.lineTo(q.x, q.y); context.stroke();
    }
    hand.forEach(point => dot(point, 'rgb(0,0,255)'));
  }
}

async function encodeDecode(source) {
  const blob = await new Promise((resolve, reject) => source.toBlob(value => value ? resolve(value) : reject(new Error('PNG encoding failed.')), 'image/png'));
  const bitmap = await createImageBitmap(blob);
  const decoded = canvas(bitmap.width, bitmap.height);
  decoded.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
  const original = pixels(source), restored = pixels(decoded);
  if (decoded.width !== source.width || decoded.height !== source.height || original.some((value, i) => value !== restored[i])) {
    throw new Error('Decoded PNG differs from the preview.');
  }
  return { data: new Uint8Array(await blob.arrayBuffer()), decoded };
}

// An independent CPU ray/triangle intersection checks actual encoded depth pixels.
function depthSamples(image, meshes, camera, range) {
  const data = pixels(image), { width, height } = image, samples = [];
  const ray = new THREE.Raycaster(); ray.near = camera.near; ray.far = camera.far;
  for (let y = 4; y < height - 4; y += 13) for (let x = 4; x < width - 4; x += 13) {
    const value = data[(y * width + x) * 4];
    if (!value) continue;
    // Antialiased pixels can blend different surfaces. Compare center rays only
    // on locally flat patches: check the full 3×3 range, including diagonals.
    const neighbors = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1]
      .map(offset => data[((y * width + x) + offset) * 4]);
    if (neighbors.some(v => !v) || Math.max(value, ...neighbors) - Math.min(value, ...neighbors) > DEPTH_TOLERANCE) continue;
    ray.setFromCamera(new THREE.Vector2(2 * (x + .5) / width - 1, 1 - 2 * (y + .5) / height), camera);
    const hit = ray.intersectObjects(meshes, false)[0];
    if (!hit) continue;
    const distance = -hit.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
    const expected = Math.round(255 * THREE.MathUtils.clamp((range.far - distance) / (range.far - range.near), 1 / 255, 1));
    samples.push({ x, y, joint: hit.object.userData.jointId, distance, expected, actual: value, error: Math.abs(expected - value) });
  }
  return samples;
}

export function setupControlExport({ mannequin, getPose, createZip, status }) {
  const dialog = $('control-dialog'), overlay = $('control-overlay'), poseCanvas = $('control-pose'), depthCanvas = $('control-depth');
  let renderer, controls, scene, meshes, camera, bounds, sourcePoints, snapshot, reference, last, validated, busy = false;
  const surface = new THREE.MeshStandardMaterial({ color: 0xc9c9c9, roughness: 1 });
  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: { closest: { value: 0 }, farthest: { value: 1 } },
    vertexShader: 'varying float distanceToCamera; void main(){ vec4 p = modelViewMatrix * vec4(position,1.0); distanceToCamera = -p.z; gl_Position = projectionMatrix * p; }',
    fragmentShader: 'uniform float closest; uniform float farthest; varying float distanceToCamera; void main(){ float v = clamp((farthest-distanceToCamera)/(farthest-closest),1.0/255.0,1.0); gl_FragColor = vec4(vec3(v),1.0); }',
    toneMapped: false,
  });

  function render() {
    if (!scene || busy) return;
    validated = null; $('download-control-export').disabled = true;
    const [width, height] = $('control-size').value.split('x').map(Number);
    camera.aspect = width / height; camera.fov = Number($('control-fov').value);
    $('control-fov-value').textContent = `${camera.fov}°`;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    const corners = [];
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      corners.push(-new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse).z);
    }
    const range = { near: Math.max(camera.near, Math.min(...corners) - .01), far: Math.max(camera.near + .02, Math.max(...corners) + .01) };
    renderer.setSize(width, height, false);
    for (const c of [overlay, poseCanvas, depthCanvas]) { c.width = width; c.height = height; }
    reference = canvas(width, height);
    scene.overrideMaterial = null; renderer.render(scene, camera);
    reference.getContext('2d').drawImage(renderer.domElement, 0, 0);
    const context = overlay.getContext('2d'); context.drawImage(reference, 0, 0);
    depthMaterial.uniforms.closest.value = range.near; depthMaterial.uniforms.farthest.value = range.far;
    try { scene.overrideMaterial = depthMaterial; renderer.render(scene, camera); depthCanvas.getContext('2d').drawImage(renderer.domElement, 0, 0); }
    finally { scene.overrideMaterial = null; }
    const body = project(sourcePoints.body, camera, width, height);
    const hands = $('control-hands').checked ? sourcePoints.hands.map(points => project(points, camera, width, height)) : [];
    const poseContext = poseCanvas.getContext('2d'); poseContext.fillStyle = '#000'; poseContext.fillRect(0, 0, width, height);
    drawSkeleton(poseContext, body, hands, width, height); drawSkeleton(context, body, hands, width, height);
    const cropped = [...body, ...hands.flat()].filter(point => point && !point.inFrame).map(point => point.name);
    const warnings = ['Eyes, ears and facial expression landmarks are omitted; nose is an approximate surface landmark.',
      'Hidden joints are retained in the skeleton. Occlusion and pose fidelity require visual review.'];
    if (cropped.length) warnings.push(`Outside frame or clipping range (${cropped.length}): ${cropped.join(', ')}. Connections to these landmarks are omitted.`);
    // Check actual mesh vertices, not just the landmarks, for cropped hands/head/surfaces.
    let surfaceClipped = false;
    for (const mesh of meshes) {
      const positions = mesh.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        const p = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).project(camera);
        if (Math.abs(p.x) >= 1 || Math.abs(p.y) >= 1 || Math.abs(p.z) >= 1) { surfaceClipped = true; break; }
      }
      if (surfaceClipped) break;
    }
    if (surfaceClipped) warnings.push('Mannequin surface is cropped or crosses a clipping plane. Use Frame body for full-body output.');
    last = { formatVersion: 1, width, height, body, hands, cropped, surfaceClipped, warnings,
      depth: { ...range, encoding: '8-bit grayscale, linear camera-space distance; nearer=brighter; background=0; surfaces=1..255' },
      camera: { type: 'perspective', fov: camera.fov, aspect: camera.aspect, near: camera.near, far: camera.far,
        position: camera.position.toArray(), target: controls.target.toArray(), worldMatrix: camera.matrixWorld.toArray(), projectionMatrix: camera.projectionMatrix.toArray() } };
    $('control-validation').textContent = 'Not validated · inspect the overlay, then validate the PNGs.';
    $('control-warnings').replaceChildren(...warnings.map(warning => { const item = document.createElement('li'); item.textContent = warning; return item; }));
  }

  function frame() {
    const center = bounds.getCenter(new THREE.Vector3());
    const [width, height] = $('control-size').value.split('x').map(Number);
    const vertical = THREE.MathUtils.degToRad(Number($('control-fov').value) / 2);
    const direction = camera.position.clone().sub(controls.target).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    let distance = .15;
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const corner = new THREE.Vector3(x, y, z).sub(center);
      distance = Math.max(distance, corner.dot(direction) + Math.max(Math.abs(corner.dot(right)) / (Math.tan(vertical) * width / height), Math.abs(corner.dot(up)) / Math.tan(vertical)));
    }
    controls.target.copy(center); camera.position.copy(center).addScaledVector(direction, distance * 1.08);
    controls.update(); render();
  }

  function setBusy(value) {
    busy = value; controls.enabled = !value;
    for (const input of dialog.querySelectorAll('button,input,select')) input.disabled = value;
    $('download-control-export').disabled = value || !validated;
  }

  $('open-control-export').addEventListener('click', () => {
    try {
      if (!renderer) {
        renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
        renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
        renderer.domElement.addEventListener('webglcontextlost', event => {
          event.preventDefault(); validated = null; $('download-control-export').disabled = true;
          $('control-validation').textContent = 'Graphics context lost. Close and reload the app before exporting.';
        });
      }
      controls?.dispose();
      mannequin.root.updateWorldMatrix(true, true);
      snapshot = structuredClone(getPose()); sourcePoints = landmarks(mannequin);
      scene = new THREE.Scene(); scene.background = new THREE.Color(0);
      meshes = mannequin.pickables.map(original => {
        const mesh = new THREE.Mesh(original.geometry, surface); mesh.matrix.copy(original.matrixWorld); mesh.matrixAutoUpdate = false;
        mesh.userData.jointId = original.userData.jointId;
        scene.add(mesh); return mesh;
      });
      scene.updateMatrixWorld(true); bounds = new THREE.Box3().setFromObject(scene);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2));
      const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(-3, 4, 5); scene.add(key);
      camera = new THREE.PerspectiveCamera(40, 2 / 3, .01, 100);
      const center = bounds.getCenter(new THREE.Vector3()); camera.position.copy(center).add(new THREE.Vector3(0, 0, 4));
      controls = new OrbitControls(camera, overlay); controls.target.copy(center); controls.minDistance = .15; controls.maxDistance = 30;
      controls.addEventListener('change', render);
      $('reference-dialog').close(); dialog.showModal(); frame();
    } catch (error) { status(`Control export could not open: ${error.message}`, 'error'); }
  });
  $('close-control-export').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { controls?.dispose(); validated = null; scene = null; });
  $('control-frame').addEventListener('click', frame);
  $('control-size').addEventListener('change', render);
  $('control-fov').addEventListener('input', render);
  $('control-hands').addEventListener('change', render);
  $('validate-control-export').addEventListener('click', async () => {
    if (busy) return;
    validated = null; setBusy(true); $('control-validation').textContent = 'Validating encoded PNGs and surface depth…';
    try {
      const files = [];
      for (const [name, source] of [['openpose.png', poseCanvas], ['depth.png', depthCanvas], ['reference.png', reference], ['overlay.png', overlay]]) {
        const encoded = await encodeDecode(source); files.push({ name, data: encoded.data, decoded: encoded.decoded });
      }
      for (const file of files) {
        const data = pixels(file.decoded);
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] !== 255) throw new Error(`${file.name} is not opaque.`);
          if (file.name === 'depth.png' && (data[i] !== data[i + 1] || data[i] !== data[i + 2])) throw new Error('Depth is not grayscale.');
        }
      }
      if (last.body.filter(point => point?.inFrame).length < 2) throw new Error('Too few body landmarks in frame. Use Frame body.');
      const samples = depthSamples(files[1].decoded, meshes, camera, last.depth);
      if (samples.length < 5) throw new Error('Too little visible surface to validate depth. Move closer or use Frame body.');
      const maxError = Math.max(...samples.map(sample => sample.error));
      if (maxError > DEPTH_TOLERANCE) throw new Error(`Depth differs from surface geometry by ${maxError}/255. Export blocked.`);
      const checks = { pngRoundTripExact: true, matchingDimensions: true, opaque: true, grayscaleDepth: true,
        surfaceDepth: { count: samples.length, maxError, tolerance: DEPTH_TOLERANCE, samples } };
      const report = { ...last, checks, generatedImageFidelity: 'Not evaluated; manual overlay and overlap review required.' };
      const textFile = (name, value) => ({ name, data: new TextEncoder().encode(value) });
      files.push(textFile('validation.json', JSON.stringify(report, null, 2)), textFile('pose.json', JSON.stringify(snapshot, null, 2)),
        textFile('README.txt', 'ThreeJSPoser control maps prototype\n\nUse openpose.png with an SD 1.5 OpenPose ControlNet and depth.png with an SD 1.5 depth ControlNet (control_v11f1p_sd15_depth). These maps are already prepared: bypass pose/depth preprocessors.\nKeep the exported aspect ratio and identical framing for both maps.\nreference.png and overlay.png are inspection images, not control maps.\nvalidation.json records the perspective camera, pixel-space landmarks, depth convention and decoded-PNG checks. pose.json is the unchanged editor pose snapshot.\n\nEyes/ears/face expressions are not supplied. The nose is a proxy; hand tips derive from finger geometry. Hidden joints are retained. Check overlap manually. Depth contains segmented mannequin proportions.\nPassing checks does not establish 90% generated-image fidelity or replace testing in ComfyUI/Forge.\n'));
      validated = files.map(({ name, data }) => ({ name, data }));
      $('control-validation').textContent = `PNG checks passed · ${samples.length} surface samples · max depth error ${maxError}/255. Review warnings before use.`;
    } catch (error) { $('control-validation').textContent = `Validation failed: ${error.message}`; }
    finally { setBusy(false); }
  });
  $('download-control-export').addEventListener('click', async () => {
    if (!validated || busy) return;
    setBusy(true);
    try {
      const zip = await createZip(validated), url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
      const link = document.createElement('a'); link.href = url; link.download = `threejs-control-maps-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000); status('Validated control maps ZIP downloaded');
    } catch (error) { $('control-validation').textContent = `Download failed: ${error.message}`; }
    finally { setBusy(false); }
  });
}
