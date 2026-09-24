# lions

WebXR visualisation of a GPS-collared mountain lion (puma 164M) moving over
the Santa Cruz Mountains. Built on the same architecture as the
[seals](https://github.com/smrghsh/seals) demo: a Web Mercator tile grid
displaced into a "topobath" mesh, fat-line animal tracks you can click to
raise a callout, in-world graphs, and the `brahma` submodule for XR
controllers, grab-and-pull locomotion and shared sessions.

Live: https://smrghsh.github.io/lions/

## What's in the scene

- **Terrain** — 8 × 8 zoom-12 tiles (lon −122.43 to −121.73, lat 36.81 to
  37.37). Heights from AWS Terrain Tiles (Terrarium PNG), decoded on the CPU
  and handed to the vertex shader as a per-vertex attribute, so
  `Topobath.elevationAt(lat, lng)` returns exactly the height of the rendered
  surface. 1 world unit = 1 km; vertical exaggeration is a live slider.
- **Drapes** (checkboxes, bottom-left): USGS NAIP aerial imagery, NOAA
  topo-bathy colour hillshade, slope-based relief shading, 100 m contours,
  sea tint below 0 m, and a **rest-site probability** overlay — a
  time-weighted kernel density of resting fixes, down-weighted on open
  ground by a vegetation proxy derived from the imagery (there is no forest
  layer in the data, so treat it as a proxy).
- **Tracks** — 4-hour fixes (Dec 2024 – Jul 2026) and 5-minute fixes
  (Mar – Jun 2025), draped over the terrain by subdividing every hop and
  dropping the sub-points onto the surface. Coloured by movement state
  (from step length between fixes) or by continuous speed.
- **Fix voxels** — a clickable cube at every fix (`FixVoxels`, one
  `InstancedMesh` per dataset). Click one, or the track, for the callout;
  ← → scrub fixes; the right thumbstick does the same in XR.
- **Callout** — puma marker pointed along the track (heading + slope), the
  fix's time, terrain elevation, speed, step, interval, state and rest
  probability, plus three graphs of the next 200 fixes.

## Running

```
npm install
npm run dev        # https://localhost:5173 (self-signed cert, needed for WebXR)
npm run build      # -> docs/ (served by GitHub Pages)
```

## Data pipeline

```
python3 fetch_bathy.py            # terrain + NOAA + USGS tiles -> static/tiles/
python3 Raw_Data_Processing_Scripts/processdata.py   # Raw_data/*.csv -> static/*.csv
```

`fetch_bathy.py` is standard-library only (PIL for the USGS stitch). The
tile grid is set at the top of the script and mirrored in
`src/Experience/World/Topobath.js`. Overture Maps does not publish
elevation, which is why the height layer comes from the AWS Open Data
terrain tiles.

`processdata.py` turns the raw collar CSV (`animal_id, sex, latitude,
longitude, timestamp`) into one file per animal per resolution with step
length, interval, speed, heading and a movement state (1 resting … 5
running, by speed). Elevation is not written: the app looks it up from the
terrain at load time.

## Layout

```
src/Experience/
  Experience.js          singleton: constants, pointer, XR loop
  World/
    Topobath.js          tile grid, heightmap, elevationAt / placeOnTerrain
    LionPath.js          one dataset: arrays, draped Line2, voxels
    FixVoxels.js         clickable cube per fix
    SelectablePath.js    brahma Path with lion selection
    RestMap.js           rest-site KDE -> DataTexture
    Callout.js, Graphs.js, Legend.js, SeaLevelPlane.js, Sky.js, Lion.js
  xr/HandLocomotion.js   Vision Pro / Quest hand grab-and-pull
  brahma/                submodule (controllers, locomotion, networking)
shaders/bathy/           terrain vertex/fragment shaders
```

## Attributions

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (Mapzen / Tilezen Terrarium), sources include USGS 3DEP, GEBCO, ETOPO1.
- Imagery: USGS The National Map, USGSImageryOnly (NAIP), public domain.
- Hillshade: NOAA NCEI DEM Global Mosaic colour hillshade.
- Skybox: [Qwantani Noon](https://polyhaven.com/a/qwantani_noon_puresky) by
  Greg Zaal and Jarod Guest via Poly Haven.
- Puma GPS data: Santa Cruz Puma Project collar 164M (see `Raw_data/`).
