# Perspective reference package (version 1.0)

Open **Export references → Control maps prototype**, inspect the existing
perspective camera, select **Validate PNGs**, then **Download validated ZIP**.
Reopen the dialog to capture pose edits. Validation and download do not change
the editor pose or saved files.

The image camera and automatic framing behavior are unchanged. Every image and
projected landmark uses the dialog's captured pose, perspective camera and selected
resolution. `pose-export.json` retains the existing complete export schema and
the editor's `camera.front`; **that Front camera is not the package image camera**.
Use `manifest.camera` to reproduce the images. The original complete-pose action
and legacy pose files remain supported.

| File | Purpose |
|---|---|
| `openpose.png` | Existing COCO-18 body guide with optional hands |
| `depth.png` | Existing opaque 8-bit linear grayscale conditioning depth |
| `mannequin.png` | Uniform gray mannequin with controlled lighting, without editor helpers |
| `reference.png` | Backward-compatible identical copy of `mannequin.png` |
| `overlay.png` | Skeleton drawn over the mannequin for inspection |
| `silhouette.png` | Binary mask: black background, white foreground |
| `segmentation.png` | Exact body-part palette colors, background black |
| `depth16.png` | Linear depth encoded in raw red/green bytes for validation |
| `decode-depth.js` | Standalone JavaScript decoder, with no dependencies |
| `pose-export.json` | Complete hierarchy, geometry, transforms, procedural source and editor cameras |
| `pose.json` | Original editable pose format |
| `landmarks.json` | Anatomical names, rig-node associations, world/pixel/normalized positions and visibility |
| `validation.json` | Decoded PNG checks and sampled independent CPU surface comparisons |
| `manifest.json` | Camera, conventions, palette, depth range, shared snapshot ID and SHA-256 file hashes |
| `README.txt` | Package usage and encoding information |

## Data passes and precision

Silhouette and segmentation use the same unmultisampled pixel centers and depth
testing as packed depth. There is no lighting, tone mapping, color conversion,
blending or dithering in these data passes. Mask and segmentation boundaries match
exactly. Shaded reference and ordinary depth retain antialiasing, so their boundary
pixels can blend foreground and background. Do not infer metric depth from those
blended edge pixels.

Both depth outputs encode **linear camera-space distance** `d = -cameraSpace.z`
in metres, with nearer surfaces brighter/higher. They use exactly the same camera,
pose, resolution and near/far normalization range. The range is computed from the
captured world bounds transformed into camera space, with 0.01 m padding; the near
bound is clamped to the camera near plane. It is recorded in `manifest.depth` and
recomputed when the camera changes. This is not a fixed range across packages.
The camera's clipping planes remain separate from the normalization range.

For `depth.png`, each channel stores:

```js
q8 = round(255 * clamp((far - d) / (far - near), 1 / 255, 1));
```

For `depth16.png`, let `span = far - near`:

```js
q = round(65535 * clamp((far - d) / span, 1 / 65535, 1));
R = floor(q / 256); // high byte
G = q % 256;       // low byte
B = 0;
A = 255;

q = R * 256 + G;   // big-endian unsigned 16-bit value
d = q === 0 ? null : far - (q / 65535) * span;
```

Zero identifies background, and valid surfaces use codes 1–65535. The quantization
step is `span/65535` metres; rounding error is at most `span/131070` metres away
from the reserved far-end code. Reserving zero can introduce up to one step at
the far endpoint. These bounds describe quantization, not total GPU rendering error.
All bounds are recorded in real-world units in the manifest.

GPU rasterization and CPU ray/triangle intersections can differ at subpixel
precision. Validation records actual sampled errors and allows up to 16 codes
(`16*span/65535` metres), separately from quantization. It does not exhaustively
prove every rendered depth pixel. PNG byte encoding/decoding must match exactly.

Read the packed PNG as raw RGB bytes. Do not resize, filter, color-correct or
apply gamma to it. `decode-depth.js` exports `decodeDepth16(R, G, manifest.depth)`;
the source utility also has an encoder in `src/depth-codec.js`. All 65,536 codes,
including background, have an exact numeric round-trip test. This is an RGB8 PNG
containing 16-bit data, not a 16-bit grayscale PNG. It is not directly a ControlNet
conditioning image. The data-pass/codec boundary allows future grayscale16 or EXR
encoders without changing the editor or ordinary depth output.

## Landmarks and occlusion

World coordinates are right-handed metres, +Y up and anatomical left +X. Image
origin is top-left, +X right and +Y down. Pixel coordinates are continuous image-edge
coordinates; pixel centers are `(column+0.5,row+0.5)`. Normalized coordinates are
`[x/width,y/height]`, without clamping. Camera depth uses the same convention as
the depth images. Rig-node IDs refer to the included complete JSON.

Each available landmark records its exact rig transform or explicitly labels its
source as an approximate head anchor or geometry-derived fingertip. Missing body
landmarks are listed separately. Disabled hands are an omitted group, not missing
rig data. Out-of-frame landmarks retain their numeric positions.

Visibility classifies the landmark's **associated body-part surface**, not literal
visibility of a joint buried inside geometry. A ray through the exact projected
position finds the nearest front-facing triangle within camera clipping planes.
Its own anatomical segment and immediate parent segment support joint sockets.
The first supporting surface is `visible`; a foreign surface at least 0.0001 m
in front of the landmark is `occluded`, with the occluder's joint and segment ID.
No ray hit, a near-coincident foreign surface, or a foreign surface behind the
landmark is `unknown`. Unavailable and out-of-frame states have `occluded: null`.

This definition deliberately does not resolve visibility within one supporting
segment (for example folded fingers), or whether the back of a head anchor itself
is exposed. Approximate face anchors remain approximate. Hidden joints are still
drawn in the OpenPose guide. Generated-image visibility and fidelity are not tested.

## Identity, reproducibility and downstream use

The snapshot SHA-256 hashes the complete pose/transforms, rig, geometry and source,
image camera, resolution and hands option using UTF-8 `JSON.stringify` in emitted
property order. It is shared by manifest and landmarks. Each companion file has
its own byte hash; the manifest lists every file except itself. The complete
JSON's original pose-only hash retains its existing meaning.

The palette has explicit stable IDs, RGB colors, names and joint assignments in
the manifest. Neck, spine, pelvis and clavicles map to torso; fingers map to their
respective hand, toes to foot, and forearm twist geometry to forearm. Palette
changes require a new palette version. Unknown geometry assignments block export.

Existing OpenPose/depth conditioning usage remains unchanged. Silhouette,
segmentation and landmarks are additional inspection/validation inputs; use them
only with workflows supporting their documented formats. Do not assume the
segmentation palette matches a particular segmentation ControlNet. No character
identity generation, model configuration or new ComfyUI integration is added.

Tests exercise actual UI edits, validation and ZIP downloads, independent world
positions/projection, byte hashes, binary masks, exact palettes, depth samples,
occlusion fixtures, repeated exports and editor preservation. Repeatability is
checked in the same browser/GPU; cross-GPU byte equality is not promised.
