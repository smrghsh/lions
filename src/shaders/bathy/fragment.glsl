// Colour drapes (each toggled by a checkbox in the 2D panel)
uniform sampler2D uTextureUsgs; // USGS NAIP aerial imagery
uniform sampler2D uTextureNoaa; // NOAA topo-bathy colour hillshade
uniform sampler2D uRestMap;     // R = relative rest-site probability
uniform float uSatellite;       // 0/1 imagery layer
uniform float uHillshadeLayer;  // 0/1 NOAA layer
uniform float uContours;        // 0/1 contour lines every 100 m
uniform float uRestLayer;       // 0/1 rest-site probability overlay

uniform float uSeaTint;         // 0..1 strength of the below-sea-level tint
uniform float uHillshade;       // 0..1 strength of the relief shading
uniform float uExaggeration;    // vertical exaggeration, so shading matches the mesh
uniform vec3 uSun;              // world-space direction toward the sun

varying vec2 vUv;
varying float vHeight;
varying vec2 vSlope;

// magma-ish ramp for the probability overlay
vec3 heat(float p) {
    vec3 a = vec3(0.10, 0.03, 0.25);
    vec3 b = vec3(0.72, 0.21, 0.47);
    vec3 c = vec3(0.99, 0.99, 0.75);
    return p < 0.5 ? mix(a, b, p * 2.0) : mix(b, c, (p - 0.5) * 2.0);
}

void main() {
    vec3 img = texture2D(uTextureUsgs, vUv).rgb;
    vec3 hs = texture2D(uTextureNoaa, vUv).rgb;

    // hypsometric tint when no drape is checked
    vec3 hyps = mix(vec3(0.18, 0.32, 0.16), vec3(0.78, 0.70, 0.52),
                    smoothstep(0.0, 1000.0, vHeight));
    float w = uSatellite + uHillshadeLayer;
    vec3 color = w > 0.0 ? (img * uSatellite + hs * uHillshadeLayer) / w : hyps;

    // Monterey Bay sits in the south-east of the grid: tint the seafloor so
    // the topobath reads as bathymetry even on the imagery layer.
    if (vHeight < 0.0) {
        float t = clamp(-vHeight / 400.0, 0.0, 1.0);
        vec3 sea = mix(vec3(0.20, 0.45, 0.60), vec3(0.03, 0.10, 0.25), t);
        color = mix(color, sea, uSeaTint);
    }

    // Hillshade from the precomputed slope: the displaced surface normal in
    // world space is (-dh/dx, 1, -dh/dz) once heights are exaggerated.
    vec3 n = normalize(vec3(-vSlope.x * uExaggeration, 1.0, -vSlope.y * uExaggeration));
    float light = 0.45 + 0.65 * max(dot(n, normalize(uSun)), 0.0);
    color *= mix(1.0, light, uHillshade);

    // Contours: thin every 100 m, heavier every 500 m
    if (uContours > 0.5) {
        float h = vHeight / 100.0;
        float aa = fwidth(h) * 1.2;
        float f = fract(h);
        float d = min(f, 1.0 - f);
        float minor = 1.0 - smoothstep(0.0, aa, d);
        float f5 = fract(h / 5.0);
        float d5 = min(f5, 1.0 - f5) * 5.0;
        float major = 1.0 - smoothstep(0.0, aa * 1.8, d5);
        color = mix(color, vec3(0.12, 0.08, 0.05), clamp(0.45 * minor + 0.4 * major, 0.0, 0.8));
    }

    // Rest-site probability overlay
    if (uRestLayer > 0.5) {
        float p = texture2D(uRestMap, vUv).r;
        color = mix(color, heat(p), smoothstep(0.02, 0.45, p) * 0.85);
    }

    gl_FragColor = vec4(color, 1.0);
}
