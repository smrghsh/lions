#!/usr/bin/env python3
"""
Lions Terrain Tile Fetcher - Pre-downloads elevation + color tiles for the
Santa Cruz Mountains so the app can serve them locally (static/tiles/).

Same shape as the seals repo's fetch_bathy.py, but standard-library only
(urllib + concurrent.futures) and with three layers instead of two:

  terrain  AWS Terrain Tiles ("terrarium" PNG encoding, Mapzen / Tilezen)
           height_m = (R * 256 + G + B / 256) - 32768
           Covers land AND seafloor, so Monterey Bay reads as bathymetry.
  noaa     NOAA NCEI global topo-bathy color hillshade (WMS, 512 px) — the
           same color layer the seals demo drapes on its topobath.
  usgs     USGS The National Map imagery (public-domain NAIP aerials), four
           z+1 tiles stitched into one 512 px tile per grid cell.

Usage:
  python fetch_bathy.py [mode] [--origin lat,lon] [--zoom z]

Modes:
  all (default) - Download every layer
  terrain       - Only the terrarium height tiles
  noaa          - Only the NOAA hillshade tiles
  usgs          - Only the USGS imagery tiles
  manifest      - Generate manifest only (no downloads)
  list          - Print all URLs and paths (no downloads)

Note: Overture Maps does not publish elevation, which is why the height
layer comes from the AWS Open Data terrain tiles instead.
"""

import argparse
import io
import json
import math
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ==============================================================================
# CONFIGURATION - Change these values to fetch different tile sets
# ==============================================================================

# Origin point (lat, lon). Centre of puma 164M's home range in the
# Santa Cruz Mountains (between Big Basin, Loma Prieta and Santa Cruz).
ORIGIN = (37.09, -122.00)

# Tile zoom level (z12: ~30 m per terrarium pixel at this latitude)
TILE_ZOOM = 12

# X offset range (relative to origin tile)
DX_MIN, DX_MAX = -4, 3

# Y offset range (relative to origin tile)
DY_MIN, DY_MAX = -4, 3

# Download settings
CONCURRENCY = 8
TIMEOUT_SECS = 30
RETRIES = 3

# Path configuration
MANIFEST_PATH = Path("static/lions-tiles.json")
CSV_PATH = Path("lions-tiles.csv")
TERRAIN_TILE_DIR = Path("static/tiles/terrain")
NOAA_TILE_DIR = Path("static/tiles/noaa")
USGS_TILE_DIR = Path("static/tiles/usgs")

# URL templates
TERRAIN_URL_TEMPLATE = (
    "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
)
NOAA_WMS_TEMPLATE = (
    "https://gis.ngdc.noaa.gov/arcgis/services/DEM_mosaics/DEM_global_mosaic_hillshade/ImageServer/WMSServer"
    "?bbox={x1},{y1},{x2},{y2}"
    "&format=image/png"
    "&service=WMS"
    "&version=1.1.1"
    "&request=GetMap"
    "&srs=EPSG:3857"
    "&transparent=true"
    "&width=512"
    "&height=512"
    "&layers=DEM_global_mosaic_hillshade:ColorHillshade"
)
# ArcGIS tile scheme is z/y/x. Fetched at zoom+1 and stitched 2x2 -> 512 px.
USGS_URL_TEMPLATE = (
    "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"
)

USER_AGENT = "lions-webxr-tile-fetcher/1.0 (research visualization; contact via repo)"

# ==============================================================================
# UTILITY FUNCTIONS
# ==============================================================================


def lat_long_to_web_mercator(lat, lon):
    """Convert lat/lon to Web Mercator (EPSG:3857) metres."""
    R = 6378137
    x = R * lon * math.pi / 180
    sin_lat = math.sin(lat * math.pi / 180)
    y = R * math.log((1 + sin_lat) / (1 - sin_lat)) / 2
    return (x, y)


def lat_long_to_tile(lat, lon, zoom):
    """Slippy-map tile containing lat/lon (same maths as mercantile.tile)."""
    n = 2 ** zoom
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return x, y


def tile_bounds(x, y, zoom):
    """(west, south, east, north) in degrees for a slippy tile."""
    n = 2 ** zoom
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return west, south, east, north


def compute_tile_manifest(origin, zoom, dx_min, dx_max, dy_min, dy_max):
    lat, lon = origin
    initial_x, initial_y = lat_long_to_tile(lat, lon, zoom)
    manifest = []
    for dx in range(dx_min, dx_max + 1):
        for dy in range(dy_min, dy_max + 1):
            x = initial_x + dx
            y = initial_y + dy
            west, south, east, north = tile_bounds(x, y, zoom)
            x1, y1 = lat_long_to_web_mercator(south, west)
            x2, y2 = lat_long_to_web_mercator(north, east)
            manifest.append(
                {
                    "z": zoom,
                    "x": x,
                    "y": y,
                    "bounds": {"west": west, "south": south, "east": east, "north": north},
                    "terrainUrl": TERRAIN_URL_TEMPLATE.format(z=zoom, x=x, y=y),
                    "noaaUrl": NOAA_WMS_TEMPLATE.format(x1=x1, y1=y1, x2=x2, y2=y2),
                    "usgsUrls": [
                        USGS_URL_TEMPLATE.format(z=zoom + 1, x=2 * x + i, y=2 * y + j)
                        for j in (0, 1)
                        for i in (0, 1)
                    ],
                    "terrainLocal": str(TERRAIN_TILE_DIR / f"Terrarium-{x}-{y}.png"),
                    "noaaLocal": str(NOAA_TILE_DIR / f"NOAA-{x}-{y}.png"),
                    "usgsLocal": str(USGS_TILE_DIR / f"USGS-{x}-{y}.png"),
                }
            )
    return manifest


def write_manifest(manifest, manifest_path):
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    xs = [e["x"] for e in manifest]
    ys = [e["y"] for e in manifest]
    doc = {
        "zoom": manifest[0]["z"],
        "origin": {"lat": ORIGIN[0], "lon": ORIGIN[1]},
        "xRange": [min(xs), max(xs)],
        "yRange": [min(ys), max(ys)],
        "tiles": manifest,
    }
    with open(manifest_path, "w") as f:
        json.dump(doc, f, indent=2)
    print(f"✓ Manifest written to {manifest_path}")


def write_csv_manifest(manifest, csv_path):
    with open(csv_path, "w") as f:
        f.write("z,x,y,terrainUrl,noaaUrl,terrainLocal,noaaLocal,usgsLocal\n")
        for e in manifest:
            f.write(
                f"{e['z']},{e['x']},{e['y']},{e['terrainUrl']},{e['noaaUrl']},"
                f"{e['terrainLocal']},{e['noaaLocal']},{e['usgsLocal']}\n"
            )
    print(f"✓ CSV manifest written to {csv_path}")


def should_download(path, min_size=100):
    if not path.exists():
        return True
    return path.stat().st_size <= min_size


# ==============================================================================
# DOWNLOAD FUNCTIONS
# ==============================================================================


def fetch_bytes(url, retries=RETRIES):
    """GET a URL with exponential-backoff retries. Returns bytes or None."""
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECS) as resp:
                if resp.status == 200:
                    return resp.read()
                last_err = f"HTTP {resp.status}"
        except Exception as e:  # noqa: BLE001
            last_err = e
        if attempt < retries - 1:
            time.sleep(2 ** attempt)
    print(f"\n✗ Failed to download {url}: {last_err}")
    return None


def download_simple(url, output_path):
    data = fetch_bytes(url)
    if data is None:
        return False
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(data)
    return True


def download_usgs_stitched(urls, output_path):
    """Fetch four z+1 imagery tiles and stitch them into one 512 px PNG."""
    from PIL import Image  # only needed for the usgs layer

    canvas = Image.new("RGB", (512, 512))
    for idx, url in enumerate(urls):
        data = fetch_bytes(url)
        if data is None:
            return False
        img = Image.open(io.BytesIO(data)).convert("RGB")
        i, j = idx % 2, idx // 2
        canvas.paste(img, (i * 256, j * 256))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, "PNG", optimize=True)
    return True


def build_tasks(manifest, mode):
    tasks = []
    for e in manifest:
        if mode in ("all", "terrain") and should_download(Path(e["terrainLocal"])):
            tasks.append(("terrain", e["terrainUrl"], Path(e["terrainLocal"])))
        if mode in ("all", "noaa") and should_download(Path(e["noaaLocal"])):
            tasks.append(("noaa", e["noaaUrl"], Path(e["noaaLocal"])))
        if mode in ("all", "usgs") and should_download(Path(e["usgsLocal"])):
            tasks.append(("usgs", e["usgsUrls"], Path(e["usgsLocal"])))
    return tasks


def run_task(task):
    kind, src, path = task
    if kind == "usgs":
        return download_usgs_stitched(src, path)
    return download_simple(src, path)


def download_tiles(manifest, mode):
    tasks = build_tasks(manifest, mode)
    if not tasks:
        print("✓ All tiles already downloaded (skipping files > 100 bytes)")
        return True
    print(f"Downloading {len(tasks)} tiles with {CONCURRENCY} workers...")
    failures = []
    done = 0
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {pool.submit(run_task, t): t for t in tasks}
        for fut in as_completed(futures):
            done += 1
            ok = fut.result()
            if not ok:
                failures.append(futures[fut])
            print(f"\r  {done}/{len(tasks)} tiles", end="", flush=True)
    print()
    if failures:
        print(f"✗ {len(failures)} tiles failed to download:")
        for kind, src, path in failures[:10]:
            print(f"  - [{kind}] {path}")
        return False
    print(f"✓ Successfully downloaded {len(tasks)} tiles")
    return True


# ==============================================================================
# CLI FUNCTIONS
# ==============================================================================


def print_tile_list(manifest):
    print(f"Tile manifest ({len(manifest)} tiles):\n")
    for e in manifest:
        print(f"TERRAIN: {e['terrainUrl']}\n  -> {e['terrainLocal']}")
        print(f"NOAA:    {e['noaaUrl']}\n  -> {e['noaaLocal']}")
        print(f"USGS:    {e['usgsUrls'][0]} (+3)\n  -> {e['usgsLocal']}\n")


def print_summary(manifest, origin):
    xs = [e["x"] for e in manifest]
    ys = [e["y"] for e in manifest]
    w = min(e["bounds"]["west"] for e in manifest)
    e_ = max(e["bounds"]["east"] for e in manifest)
    s = min(e["bounds"]["south"] for e in manifest)
    n = max(e["bounds"]["north"] for e in manifest)
    print(f"\n{'=' * 60}\nSUMMARY\n{'=' * 60}")
    print(f"Origin:       {origin[0]:.6f}, {origin[1]:.6f} (lat, lon)")
    print(f"Zoom level:   {manifest[0]['z']}")
    print(f"Total tiles:  {len(manifest)}  ({max(xs) - min(xs) + 1} cols x {max(ys) - min(ys) + 1} rows)")
    print(f"X range:      {min(xs)} to {max(xs)}")
    print(f"Y range:      {min(ys)} to {max(ys)}")
    print(f"Lon range:    {w:.4f} to {e_:.4f}")
    print(f"Lat range:    {s:.4f} to {n:.4f}")
    print(f"Terrain:      {TERRAIN_TILE_DIR}")
    print(f"NOAA:         {NOAA_TILE_DIR}")
    print(f"USGS:         {USGS_TILE_DIR}")
    print(f"Manifest:     {MANIFEST_PATH}\n{'=' * 60}\n")


# ==============================================================================
# MAIN
# ==============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Fetch Santa Cruz Mountains terrain tiles for local serving",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "mode",
        nargs="?",
        default="all",
        choices=["all", "terrain", "noaa", "usgs", "manifest", "list"],
    )
    parser.add_argument("--origin", type=str, help='Override origin as "lat,lon"')
    parser.add_argument("--zoom", type=int, help="Override tile zoom level")
    args = parser.parse_args()

    origin = ORIGIN
    zoom = TILE_ZOOM
    if args.origin:
        try:
            lat, lon = map(float, args.origin.split(","))
            origin = (lat, lon)
        except ValueError:
            print("✗ Invalid origin format. Use: lat,lon")
            sys.exit(1)
    if args.zoom:
        zoom = args.zoom

    print("Generating tile manifest...")
    manifest = compute_tile_manifest(origin, zoom, DX_MIN, DX_MAX, DY_MIN, DY_MAX)
    write_manifest(manifest, MANIFEST_PATH)
    write_csv_manifest(manifest, CSV_PATH)
    print_summary(manifest, origin)

    if args.mode == "list":
        print_tile_list(manifest)
        return
    if args.mode == "manifest":
        print("✓ Manifest generated. Run with 'all', 'terrain', 'noaa' or 'usgs' to download tiles.")
        return

    if not download_tiles(manifest, args.mode):
        print("\n✗ Some tiles failed to download. Check errors above.")
        sys.exit(1)
    print("\n✓ All tiles downloaded successfully!")
    print("Vite serves static/ at '/', so ./tiles/... resolves in the app.")


if __name__ == "__main__":
    main()
