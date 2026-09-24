// Per-vertex elevation in metres, decoded on the CPU from the terrarium
// tiles (Topobath.loadBathy) so that Topobath.elevationAt() and this shader
// read exactly the same numbers and a lat/lng lands on the rendered surface.
attribute float aHeight;
// Ground slope at the vertex (rise/run, metres per metre): x = east, y = south.
attribute vec2 aSlope;

uniform float uHeightScalar; // verticalExaggeration / metersPerUnit

varying vec2 vUv;
varying float vHeight;
varying vec2 vSlope;

void main() {
    vUv = uv;
    vHeight = aHeight;
    vSlope = aSlope;

    // Displace along the plane normal; the mesh is rotated -90deg about X
    // so local +z becomes world +y.
    vec3 modifiedPosition = position;
    modifiedPosition.z += aHeight * uHeightScalar;

    vec4 modelPosition = modelMatrix * vec4(modifiedPosition, 1.0);
    vec4 viewPosition = viewMatrix * modelPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;

    gl_Position = projectedPosition;
}
