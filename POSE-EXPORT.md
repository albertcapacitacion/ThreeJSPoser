# Complete pose export (format 1.0)

**Export Complete Pose** downloads `pose-export.json`. Save pose, Open pose and
reference ZIPs retain their original format. The new file is a reconstruction
format, not an input for the existing Open pose button. Its `pose` object contains
the original `version`, `rig`, `limits` and exact `rotations` values.

[Example pose-export.json](examples/pose-export.json) was downloaded through the
app UI with the default standing pose loaded at a 1280×720 browser viewport.
It is a sample, not a capture of an existing user's browser session.

## Coordinates and hierarchy

The rig is an ordinary Three.js Object3D hierarchy with 54 Group joints, not a
skinned mesh. Units are metres; +Y is up, +Z is forward, and anatomical left is
+X (the viewer's right in Front). Coordinates are right-handed. Joint rotations
are local XYZ Euler angles; legacy rotations are degrees. Transforms include
explicit radians, degrees, order, XYZW quaternions and column-major matrices.

`rig.nodes` is the actual parent-first depth-first traversal, including ancestor,
root, intermediate and mesh nodes. IDs are export-local; names preserve the
scene's actual names, including empty names. `rig.root` identifies the mannequin
group. `rig.joints` maps exact joint names to node IDs and nearest parent joints.
Mesh names in `geometry.segments` are generated when the actual mesh is unnamed.
Editor marker subtrees are excluded.

`restPose.transforms[nodeId]` is captured once after initialization, before user
edits. This is the original arms-down pose, including the initial shoulder,
elbow and thumb rotations. `pose.transforms[nodeId]` describes the current pose.
Both contain local TRS/Euler/matrix and world TRS/matrix. World matrices are
authoritative if nonuniform parent scales introduce shear. Current rig and mesh
local transforms are also included with their respective definitions.

## Geometry and source

The JSON contains shared Three.js SphereGeometry and CapsuleGeometry resources
with exact constructor parameters, plus material definitions and each mesh's
local transform. The primitives are unmodified in geometry space: shape offsets,
orientation and ellipsoid proportions are encoded in mesh transforms. No vertex
buffers or companion GLB are needed for this rig. Unsupported future geometry
fails export rather than silently producing an incomplete file.

`geometry.proceduralSource.files` embeds the exact local `rig.js` and
`mannequin.js` ES module source. To use it, save both files together and resolve
their `three` import using the project's installed Three.js version (currently
0.186.1; the file also records `THREE.REVISION`). Call `createMannequin(scene)`,
then `mannequin.sync(createPose())` for rest or `mannequin.sync(data.pose)` for
the exported pose. Creating the groups alone does not apply the default joint
angles. Additional root/ancestor transforms must come from the exported data.
Embedded code is reference material; the app does not execute it on import.

For reconstruction without the generator, [src/reconstruct-pose.js](src/reconstruct-pose.js)
is a reference decoder requiring only Three.js and this JSON. It constructs a
fresh hierarchy from `rig.nodes`, initializes rest transforms, applies current
transforms and rebuilds primitive meshes and the Front camera. Use
`reconstructPose(data, true)` for rest. No original rig constants, code execution,
external models or textures are needed. Other engines must implement equivalent
sphere/capsule primitives; matching Three.js tessellation requires its primitive
implementations. Materials use Three.js material JSON.

## Cameras and visual scope

`camera.front` is the actual live Front pane camera, preserving pan, zoom, focus
and current projection. It is not the separately reframed reference-ZIP camera.
`camera.active` contains the active camera when another view is selected.
Bounds, clipping, zoom, up vector, target, framing offset, projection and world
matrices are explicit. Orthographic aspect is the bounds ratio.

Viewport rectangles use CSS pixels with bottom-left origin relative to the
renderer canvas. Render resolution uses physical pixels. A hidden Front pane
has zero current viewport size; `lastVisibleViewport` retains its most recent
visible rectangle. `renderResolution` uses the dimensions associated with the
current projection, including reframing while hidden after a window resize.
Reconstruct at that resolution without refitting or changing the projection.

The file reconstructs the mannequin and camera. It excludes lighting, floor,
grid, fog, background, editor markers and gizmos. Reproducing the complete editor
screenshot requires that separate scene/render setup. The browser comparison
renders the original generator and JSON reconstruction with identical controlled
lighting and Front projection; it excludes those editor/environment elements.

## Validation

`validation` reports counts, parent integrity, finite transforms and root world
transform. The SHA-256 pose identifier hashes UTF-8 `JSON.stringify(pose)` with
the emitted property order; it identifies the pose/transform snapshot, not
camera, geometry or source-code changes. Arrays retain full numeric precision.

Run `npm test`. Unit validation compares reconstructed rest/current world
positions, matrices, quaternion angular distance, parents, anatomical mapping,
primitive vertices and camera projection, including transformed parent/root
groups. Browser tests exercise UI edits, pan/zoom, hidden Front, download,
unchanged pose/view/history, old import/export and embedded source fidelity.
They also generate original/reconstructed PNGs and compare all pixel channels.
Test artifacts and a fresh example download go into the ignored `work/` folder.
