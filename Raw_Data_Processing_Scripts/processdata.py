# Raw GPS collar fixes for Santa Cruz Mountains pumas.
#   Raw_data/puma_gps_22-Dec-2024_to_27-Jul-2026_4hr.csv   (4 hour fixes)
#   Raw_data/puma_gps_22-Dec-2024_to_27-Jul-2026-5min.csv  (5 minute fixes)
#
# Raw columns:  animal_id,sex,latitude,longitude,timestamp,color_hex
#
# Output columns (one CSV per animal per resolution, chunked like the seals
# repo's processdata.py so no file exceeds 5 MB):
#   Seconds,R_Time,Lat,Long,Animal_ID,Sex,Step_m,Interval_s,Speed_kmh,Heading,State_Num
#
#   Seconds     seconds since the first fix of that dataset
#   R_Time      "YYYY-MM-DD HH:MM:SS" (collar local time, as supplied)
#   Step_m      great-circle distance from the previous fix (m)
#   Interval_s  seconds since the previous fix
#   Speed_kmh   Step_m / Interval_s, in km/h
#   Heading     bearing from this fix to the next one, radians, 0 = north,
#               positive clockwise (matches the seals heading convention)
#   State_Num   movement state derived from Speed_kmh:
#               1 Resting   (< 0.05 km/h)
#               2 Local     (0.05 - 0.5)
#               3 Traveling (0.5 - 2)
#               4 Fast      (2 - 5)
#               5 Running   (> 5)
#             These are GPS step-length classes, not accelerometer states.
#
# Elevation is deliberately NOT written here: the app looks it up from the
# terrain tiles at runtime (Topobath.elevationAt) so the path always sits
# on the rendered surface.

import csv
import glob
import json
import math
import os
from datetime import datetime

RAW_DIR = "Raw_data"
OUTPUT_DIR = "static"
MANIFEST = os.path.join(OUTPUT_DIR, "LionData.json")
MAX_FILE_SIZE = 5 * 1024 * 1024  # 5 MB, same cap as the seals repo
SUFFIX_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

FIELDS = [
    "Seconds", "R_Time", "Lat", "Long", "Animal_ID", "Sex",
    "Step_m", "Interval_s", "Speed_kmh", "Heading", "State_Num",
]

STATE_THRESHOLDS_KMH = [0.05, 0.5, 2.0, 5.0]  # boundaries between states 1..5


def parse_time(s):
    # e.g. "28 Mar 2025 7:16 AM"
    return datetime.strptime(s.strip(), "%d %b %Y %I:%M %p")


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def bearing_rad(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.atan2(x, y) % (2 * math.pi)


def state_from_speed(kmh):
    state = 1
    for t in STATE_THRESHOLDS_KMH:
        if kmh >= t:
            state += 1
    return state


def resolution_tag(filename):
    base = os.path.basename(filename).lower()
    if "5min" in base:
        return "5min"
    if "4hr" in base:
        return "4hr"
    return os.path.splitext(base)[0]


def process_rows(rows):
    rows = sorted(rows, key=lambda r: r["_t"])
    t0 = rows[0]["_t"]
    out = []
    for i, r in enumerate(rows):
        prev = rows[i - 1] if i > 0 else None
        nxt = rows[i + 1] if i + 1 < len(rows) else None
        step = haversine_m(prev["lat"], prev["lon"], r["lat"], r["lon"]) if prev else 0.0
        interval = (r["_t"] - prev["_t"]).total_seconds() if prev else 0.0
        speed = (step / interval) * 3.6 if interval > 0 else 0.0
        if nxt:
            heading = bearing_rad(r["lat"], r["lon"], nxt["lat"], nxt["lon"])
        else:
            heading = out[-1]["Heading"] if out else 0.0
        out.append({
            "Seconds": int((r["_t"] - t0).total_seconds()),
            "R_Time": r["_t"].strftime("%Y-%m-%d %H:%M:%S"),
            "Lat": r["lat"],
            "Long": r["lon"],
            "Animal_ID": r["animal_id"],
            "Sex": r["sex"],
            "Step_m": round(step, 1),
            "Interval_s": int(interval),
            "Speed_kmh": round(speed, 4),
            "Heading": round(heading, 5),
            "State_Num": state_from_speed(speed),
        })
    return out


def write_chunks(base_name, records):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    # estimate rows per chunk from the first row, as the seals script does
    sample = ",".join(str(records[0][f]) for f in FIELDS) + "\n"
    rows_per_chunk = max(1, int((MAX_FILE_SIZE * 0.7) / len(sample.encode("utf-8"))))
    files = []
    for chunk_num, start in enumerate(range(0, len(records), rows_per_chunk)):
        chunk = records[start:start + rows_per_chunk]
        name = f"{base_name}-{SUFFIX_LETTERS[chunk_num]}"
        path = os.path.join(OUTPUT_DIR, f"{name}.csv")
        with open(path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS)
            w.writeheader()
            w.writerows(chunk)
        size_mb = os.path.getsize(path) / (1024 * 1024)
        print(f"  Saved {path} with {len(chunk)} rows ({size_mb:.2f} MB)")
        files.append(name)
    return files


def main():
    manifest = []
    for input_file in sorted(glob.glob(os.path.join(RAW_DIR, "*.csv"))):
        print(f"Processing {input_file}...")
        res = resolution_tag(input_file)
        by_animal = {}
        with open(input_file, newline="") as f:
            for row in csv.DictReader(f):
                try:
                    rec = {
                        "animal_id": row["animal_id"].strip(),
                        "sex": row["sex"].strip(),
                        "lat": float(row["latitude"]),
                        "lon": float(row["longitude"]),
                        "_t": parse_time(row["timestamp"]),
                        "color": row.get("color_hex", "").strip(),
                    }
                except (ValueError, KeyError) as e:
                    print(f"  skipping row {row}: {e}")
                    continue
                by_animal.setdefault(rec["animal_id"], []).append(rec)

        for animal_id, rows in by_animal.items():
            records = process_rows(rows)
            base_name = f"{animal_id}-{res}"
            files = write_chunks(base_name, records)
            manifest.append({
                "dataset": base_name,
                "animal_id": animal_id,
                "sex": rows[0]["sex"],
                "color": rows[0]["color"],
                "resolution": res,
                "fixes": len(records),
                "start": records[0]["R_Time"],
                "end": records[-1]["R_Time"],
                "files": files,
                "source": os.path.basename(input_file),
            })
            print(f"  {base_name}: {len(records)} fixes, {len(files)} chunk(s)")

    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nManifest written to {MANIFEST}")
    print("All files processed successfully!")


if __name__ == "__main__":
    main()
