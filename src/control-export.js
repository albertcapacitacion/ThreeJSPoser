import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FINGER_LENGTHS } from './rig.js';
import { HEAD_ANCHORS } from './mannequin.js';
import { renderDataMaps, PALETTE, PALETTE_VERSION, segmentId, sha256, classifyOcclusion, OCCLUSION } from './reference-package.js';
import { decodeDepth16 } from './depth-codec.js';

// COCO-18 ordering and ControlNet OpenPose palette/topology, not rig traversal order.
// Reference: Mikubill/sd-webui-controlnet/annotator/openpose/util.py.
const BODY = ['nose', 'neck', 'rightShoulder', 'rightElbow', 'rightWrist', 'leftShoulder', 'leftElbow', 'leftWrist',
  'rightHip', 'rightKnee', 'rightAnkle', 'leftHip', 'leftKnee', 'leftAnkle', 'rightEye', 'leftEye', 'rightEar', 'leftEar'];
const LINKS = [[1,2],[1,5],[2,3],[3,4],[5,6],[6,7],[1,8],[8,9],[9,10],[1,11],[11,12],[12,13],[1,0],[0,14],[14,16],[0,15],[15,17]];
const COLORS = [[255,0,0],[255,85,0],[255,170,0],[255,255,0],[170,255,0],[85,255,0],[0,255,0],[0,255,85],[0,255,170],
  [0,255,255],[0,170,255],[0,85,255],[0,0,255],[85,0,255],[170,0,255],[255,0,255],[255,0,170],[255,0,85]];
const CONTROLNET_FILE = 'openpose_controlnet.png';
const CONTROLNET_SIZE = 1024;
const DEPTH_TOLERANCE = 3;
const $ = id => document.getElementById(id);
const canvas = (width, height) => Object.assign(document.createElement('canvas'), { width, height });
const pixels = c => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;

function landmarks(mannequin) {
  const point = (name, bone = name, offset = [0, 0, 0]) => ({ name, bone, localOffset: offset,
    source: HEAD_ANCHORS[name] ? 'approximate-head-surface-anchor' : name.endsWith('Tip') ? 'geometry-derived-endpoint' : 'rig-joint',
    world: mannequin.bones[bone].localToWorld(new THREE.Vector3(...offset)).toArray() });
  const body = BODY.map(name => HEAD_ANCHORS[name] ? point(name, 'head', HEAD_ANCHORS[name])
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
    return { ...point, x: (ndc.x + 1) * width / 2, y: (1 - ndc.y) * height / 2,
      normalized: [(ndc.x + 1) / 2, (1 - ndc.y) / 2], distance,
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

export function drawControlNetSkeleton(context, body, sourceWidth, sourceHeight) {
  const { width, height } = context.canvas;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const offsetX = (width - sourceWidth * scale) / 2;
  const offsetY = (height - sourceHeight * scale) / 2;
  const maxSide = Math.max(width, height);
  // Xinsir's published size buckets apply at the final canvas size.
  const radius = 4 * (maxSide < 500 ? 1 : Math.min(7, 2 + Math.floor(maxSide / 1000)));
  const points = body.map(point => point?.inFrame
    ? { x: offsetX + point.x * scale, y: offsetY + point.y * scale } : null);

  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  context.save();
  context.beginPath();
  context.rect(offsetX, offsetY, sourceWidth * scale, sourceHeight * scale);
  context.clip();
  LINKS.forEach(([a, b], i) => {
    const p = points[a], q = points[b];
    if (!p || !q) return;
    const dx = p.x - q.x, dy = p.y - q.y;
    const angle = Math.trunc(THREE.MathUtils.radToDeg(Math.atan2(dy, dx)));
    context.fillStyle = `rgb(${COLORS[i].map(value => Math.floor(value * .6)).join(',')})`;
    context.beginPath();
    context.ellipse(Math.trunc((p.x + q.x) / 2), Math.trunc((p.y + q.y) / 2),
      Math.trunc(Math.hypot(dx, dy) / 2), radius, THREE.MathUtils.degToRad(angle), 0, Math.PI * 2);
    context.fill();
  });
  points.forEach((point, i) => {
    if (!point) return;
    context.fillStyle = `rgb(${COLORS[i].join(',')})`;
    context.beginPath();
    context.arc(Math.trunc(point.x), Math.trunc(point.y), radius, 0, Math.PI * 2);
    context.fill();
  });
  context.restore();
  return { fit: { scale, offsetX, offsetY }, limbHalfWidthPx: radius, jointRadiusPx: radius };
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

export function setupControlExport({ mannequin, getPose, captureCompleteExport, createZip, status }) {
  const dialog = $('control-dialog'), overlay = $('control-overlay'), poseCanvas = $('control-pose'), depthCanvas = $('control-depth');
  const includeControlNet = $('control-sdxl');
  let renderer, controls, scene, meshes, camera, bounds, sourcePoints, snapshot, completeSnapshot, reference, last, validated, busy = false;
  const surface = new THREE.MeshStandardMaterial({ color: 0xc9c9c9, roughness: 1 });
  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: { closest: { value: 0 }, farthest: { value: 1 } },
    vertexShader: 'varying float distanceToCamera; void main(){ vec4 p = modelViewMatrix * vec4(position,1.0); distanceToCamera = -p.z; gl_Position = projectionMatrix * p; }',
    fragmentShader: 'uniform float closest; uniform float farthest; varying float distanceToCamera; void main(){ float v = clamp((farthest-distanceToCamera)/(farthest-closest),1.0/255.0,1.0); gl_FragColor = vec4(vec3(v),1.0); }',
    toneMapped: false,
  });

  function invalidateValidation() {
    validated = null; $('download-control-export').disabled = true;
    $('control-validation').textContent = 'Not validated · inspect the overlay, then validate the PNGs.';
  }

  function render() {
    if (!scene || busy) return;
    invalidateValidation();
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
    const warnings = ['Nose, eyes and ears are approximate head-surface anchors; facial expression landmarks are omitted.',
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
      completeSnapshot = captureCompleteExport().then(data => ({ data }), error => ({ error }));
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
  includeControlNet.addEventListener('change', invalidateValidation);
  $('validate-control-export').addEventListener('click', async () => {
    if (busy) return;
    validated = null; setBusy(true); $('control-validation').textContent = 'Validating encoded PNGs and surface depth…';
    try {
      const files = [];
      const cameraId = 'control-perspective';
      let guideResolution;
      for (const [name, source] of [['openpose.png', poseCanvas], ['depth.png', depthCanvas], ['reference.png', reference], ['overlay.png', overlay]]) {
        const encoded = await encodeDecode(source); files.push({ name, data: encoded.data, decoded: encoded.decoded });
      }
      if (includeControlNet.checked) {
        const source = canvas(CONTROLNET_SIZE, CONTROLNET_SIZE);
        const drawing = drawControlNetSkeleton(source.getContext('2d'), last.body, last.width, last.height);
        const { data, decoded } = await encodeDecode(source);
        if (decoded.width !== CONTROLNET_SIZE || decoded.height !== CONTROLNET_SIZE) {
          throw new Error(`${CONTROLNET_FILE} must be ${CONTROLNET_SIZE} × ${CONTROLNET_SIZE}.`);
        }
        guideResolution = { width: decoded.width, height: decoded.height };
        files.push({ name: CONTROLNET_FILE, data, decoded, metadata: {
          resolution: guideResolution,
          sourceViewport: { x: 0, y: 0, width: last.width, height: last.height, origin: 'top-left' },
          cameraId, jointConvention: 'COCO_18', renderingConvention: 'xinsir-openpose-sdxl-1.0-canvas-v1',
          handOverlay: false, ...drawing,
        } });
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
      const captured = await completeSnapshot;
      if (captured.error) throw captured.error;
      const complete = captured.data;
      const maps = renderDataMaps(renderer, scene, meshes, camera, last.width, last.height, last.depth);
      const precisePixels = pixels(maps.depth16), maskPixels = pixels(maps.silhouette), segmentPixels = pixels(maps.segmentation);
      const paletteColors = new Set(PALETTE.map(entry => entry.rgb.join(',')));
      for (let i = 0; i < precisePixels.length; i += 4) {
        const foreground = precisePixels[i] * 256 + precisePixels[i + 1] > 0;
        if ((maskPixels[i] === 255) !== foreground ||
          Boolean(segmentPixels[i] || segmentPixels[i + 1] || segmentPixels[i + 2]) !== foreground ||
          !paletteColors.has([...segmentPixels.slice(i, i + 3)].join(','))) throw new Error('Data pass boundaries or palette differ.');
      }
      const preciseSamples = samples.map(sample => {
        const index = (sample.y * last.width + sample.x) * 4;
        const actual = precisePixels[index] * 256 + precisePixels[index + 1];
        const expected = Math.round(65535 * THREE.MathUtils.clamp((last.depth.far - sample.distance) / (last.depth.far - last.depth.near), 1 / 65535, 1));
        return { x: sample.x, y: sample.y, expected, actual, error: Math.abs(actual - expected) };
      });
      const preciseError = Math.max(...preciseSamples.map(sample => sample.error));
      // Rasterized triangles and CPU rays differ slightly at subpixel precision;
      // this is a geometry comparison tolerance, separate from 16-bit rounding.
      if (preciseError > 16) throw new Error(`Packed depth differs from geometry by ${preciseError}/65535. Export blocked.`);
      for (const [name, source] of [['mannequin.png', reference], ['silhouette.png', maps.silhouette],
        ['segmentation.png', maps.segmentation], ['depth16.png', maps.depth16]]) {
        const encoded = await encodeDecode(source); files.push({ name, data: encoded.data });
      }
      const checks = { pngRoundTripExact: true, matchingDimensions: true, opaque: true, grayscaleDepth: true,
        ...(guideResolution && {
          matchingDimensionsScope: 'legacy-pngs',
          controlNetGuideDimensions: { ...guideResolution, matchesTarget: true },
        }),
        surfaceDepth: { count: samples.length, maxError, tolerance: DEPTH_TOLERANCE, samples },
        matchingDataBoundaries: true, exactSegmentationPalette: true,
        preciseDepth: { count: preciseSamples.length, maxError: preciseError, tolerance: 16,
          maxErrorMetres: preciseError * (last.depth.far - last.depth.near) / 65535, samples: preciseSamples } };
      const report = { ...last, checks, generatedImageFidelity: 'Not evaluated; manual overlay and overlap review required.' };
      const textFile = (name, value) => ({ name, data: new TextEncoder().encode(value) });
      files.push(textFile('validation.json', JSON.stringify(report, null, 2)), textFile('pose.json', JSON.stringify(snapshot, null, 2)),
        textFile('README.txt', 'ThreeJSPoser control maps prototype\n\nUse openpose.png with an SD 1.5 OpenPose ControlNet and depth.png with an SD 1.5 depth ControlNet (control_v11f1p_sd15_depth). These maps are already prepared: bypass pose/depth preprocessors.\nKeep the exported aspect ratio and identical framing for both maps.\nreference.png and overlay.png are inspection images, not control maps.\nvalidation.json records the perspective camera, pixel-space landmarks, depth convention and decoded-PNG checks. pose.json is the unchanged editor pose snapshot.\n\nNose, eyes and ears are approximate head-surface anchors that follow head rotation. Face expressions are not supplied; hand tips derive from finger geometry. Hidden joints are retained. Check overlap manually. Depth contains segmented mannequin proportions.\nPassing checks does not establish 90% generated-image fidelity or replace testing in ComfyUI/Forge.\n'));
      files.push(textFile('pose-export.json', JSON.stringify(complete, null, 2)),
        textFile('decode-depth.js', `// Read raw PNG R/G bytes; range is manifest.depth. Zero returns null (background).\nexport ${decodeDepth16.toString()}\n`));
      const conventions = { worldUnits: 'metres', handedness: 'right-handed', worldUp: '+Y', anatomicalLeft: '+X',
        imageOrigin: 'top-left', imageX: 'right', imageY: 'down', pixelCoordinates: 'continuous image-edge coordinates; pixel centers are (column+0.5,row+0.5)',
        normalizedCoordinates: '[x/width,y/height]; not clamped', cameraDepth: '-cameraSpace.z in metres' };
      const depth = { ...last.depth, normalization: 'pose-world-bounds camera-space range plus 0.01 metres padding; recomputed on camera/pose changes',
        depth16: { encoding: 'RGB8 PNG; R=high byte, G=low byte, B=0, A=255', byteOrder: 'big-endian',
          decodeInteger: 'q = 256*R + G', encode: 'q = round(65535 * clamp((far-distance)/(far-near), 1/65535, 1))',
          decodeMetres: 'q == 0 ? null : far - q/65535*(far-near)', background: 0,
          quantizationStepMetres: (last.depth.far - last.depth.near) / 65535,
          maxRoundingErrorMetres: (last.depth.far - last.depth.near) / 131070,
          farClampMaxErrorMetres: (last.depth.far - last.depth.near) / 65535,
          cpuGeometryComparisonToleranceMetres: 16 * (last.depth.far - last.depth.near) / 65535,
          sampling: 'unmultisampled pixel centers; depth.png has antialiased boundaries',
          colorSpace: 'raw data; no color conversion or tone mapping; do not treat as display RGB or a conditioning image' } };
      const usage = files.find(file => file.name === 'README.txt');
      usage.data = new TextEncoder().encode(new TextDecoder().decode(usage.data) +
        `\nAdditional package files\nmannequin.png equals reference.png. silhouette.png is binary (0 background, 255 body). segmentation.png uses the exact palette and joint mapping in manifest.json. Neither mask uses antialiasing.\npose-export.json contains complete rig/geometry and retains editor camera.front; all package images and landmarks use the separate perspective camera in manifest.json.\nlandmarks.json documents top-left pixel coordinates, normalized coordinates, source precision and associated-body-part occlusion. Unknown and out-of-frame visibility use null, not false. Hidden joints are still drawn.\n\nPacked precision depth\ndepth16.png is RGB8 data, not grayscale16 or a conditioning image. Linear camera-space distance d=-cameraSpace.z, metres. R is the high byte, G the low byte, B=0, A=255. q=R*256+G; q=0 means background, otherwise d=far-q/65535*(far-near). Encoding: q=round(65535*clamp((far-d)/(far-near),1/65535,1)). No tone mapping or color conversion. Read raw bytes without gamma, resizing or filtering.\nThe same pose, camera, size and normalization range drive depth.png and depth16.png. depth.png is 8-bit grayscale with antialiased edges; depth16.png samples unmultisampled pixel centers.\nNear=${depth.near} m; far=${depth.far} m. Range is recomputed from bounds/camera and recorded in manifest.depth. Quantization step=${depth.depth16.quantizationStepMetres} m; maximum rounding error=${depth.depth16.maxRoundingErrorMetres} m (far-end clamp up to one step). GPU/CPU raster comparison tolerance=${depth.depth16.cpuGeometryComparisonToleranceMetres} m, separately from quantization.\nImport decodeDepth16 from decode-depth.js and call decodeDepth16(R,G,manifest.depth); background returns null.\nmanifest.json links all companion files with SHA-256 hashes and a shared pose/geometry/image-camera snapshot identifier. Palette compatibility with segmentation conditioning models is not assumed.\n`);
      const snapshotHash = await sha256(new TextEncoder().encode(JSON.stringify({ pose: complete.pose,
        rig: complete.rig, geometry: complete.geometry, camera: last.camera, width: last.width, height: last.height, hands: last.hands.length > 0 })));
      const packageId = `pose-${snapshotHash}`;
      const nodes = new Map(complete.rig.joints.map(joint => [joint.name, joint.node]));
      const jointParents = new Map(complete.rig.joints.map(joint => [joint.name, joint.parent]));
      const projected = [...last.body, ...last.hands.flat()];
      const landmarks = { formatVersion: '1.0', packageId, snapshotHash, cameraId, width: last.width, height: last.height,
        conventions, occlusion: OCCLUSION,
        landmarks: [...new Map(projected.filter(Boolean).map(point => [point.name, point])).values()].map(point => ({
          id: point.name, anatomicalName: point.name, rigJoint: point.bone, rigNode: nodes.get(point.bone), source: point.source,
          localOffset: point.localOffset, world: point.world, pixel: [point.x, point.y], normalized: point.normalized,
          cameraDepthMetres: point.distance, available: true, inFrame: point.inFrame,
          visibility: classifyOcclusion(point, meshes, camera, [segmentId(point.bone),
            segmentId(jointParents.get(point.bone) ?? point.bone)]),
        })), unavailableLandmarks: BODY.filter((name, index) => !last.body[index]),
        omittedGroups: last.hands.length ? [] : ['hands-disabled-by-user'] };
      files.push(textFile('landmarks.json', JSON.stringify(landmarks, null, 2)));
      const roles = { 'openpose.png': 'body-and-optional-hand-conditioning', 'depth.png': '8-bit-depth-conditioning',
        [CONTROLNET_FILE]: 'sdxl-openpose-body-conditioning',
        'reference.png': 'mannequin-inspection-legacy-alias', 'overlay.png': 'skeleton-alignment-inspection',
        'mannequin.png': 'mannequin-render', 'silhouette.png': 'binary-mask', 'segmentation.png': 'body-part-labels',
        'depth16.png': 'packed-16-bit-depth-validation', 'validation.json': 'validation-report', 'pose.json': 'legacy-editable-pose',
        'pose-export.json': 'complete-rig-geometry-and-editor-cameras', 'landmarks.json': 'projected-landmarks',
        'decode-depth.js': 'standalone-packed-depth-decoder', 'README.txt': 'usage' };
      const manifest = { formatVersion: '1.0', packageId, snapshotHash: { algorithm: 'SHA-256', value: snapshotHash },
        resolution: { width: last.width, height: last.height }, camera: { id: cameraId, ...last.camera },
        completePoseCamera: 'pose-export.json camera.front preserves the editor Front; package images use manifest.camera',
        conventions, depth, occlusion: OCCLUSION, segmentation: { paletteVersion: PALETTE_VERSION, palette: PALETTE,
          jointMapping: Object.fromEntries(complete.rig.joints.map(joint => [joint.name, segmentId(joint.name)])),
          sampling: 'unmultisampled; exact RGB palette; background ID=0' }, silhouette: { binary: true, background: 0, foreground: 255 },
        rendering: { threeVersion: complete.coordinateSystem.threeVersion, referenceMaterial: 'uniform gray',
          lighting: 'Hemisphere white/0x555555 intensity 2; directional white intensity 2 at (-3,4,5)',
          pixelRatio: 1, toneMapping: 'none', dataPassColorSpace: 'none' },
        files: await Promise.all(files.map(async file => ({ name: file.name, role: roles[file.name],
          sha256: await sha256(file.data), ...file.metadata }))) };
      files.push(textFile('manifest.json', JSON.stringify(manifest, null, 2)));
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
