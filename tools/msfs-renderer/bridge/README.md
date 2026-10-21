# GEV MSFS bridge

`gev-bridge` flies Microsoft Flight Simulator 2024's add-on camera along a
GEV camera path, and can have OBS record it. It runs on the cloud machine
(`../README.md`), next to the sim. The path comes from this PC:

```bash
npm run msfs:path -- --from 39.2904,-76.6122 --via 39.3100,-76.6000 --to 39.3299,-76.6205 --speed 40 --agl 150 --out baltimore.json
```

That is `scripts/msfs/cameraPath.mjs`:

- **Track:** great-circle legs through the points, each corner a circular
  turn of the radius the speed allows at 25° of bank, sampled at the frame
  rate.
- **Altitude:** terrain (the app's raster values, layer `ee-elevation`, the
  DEM stack) plus the AGL. It climbs at most 8% ahead of rising ground and
  is smoothed, so it never drops below terrain + AGL.
- **Angles:** heading from the track, pitch from the climb, and bank from the
  turn rate, at half a coordinated turn's.

`--mode road` is accepted but follows the same straight legs: the Overture
roads index has no routing graph yet, so put via points along the road.

The file is `{ version: 1, fps, samples: [{ t, lat, lon, alt_m, heading_deg,
pitch_deg, bank_deg, fov_deg }], meta }`, with these conventions:

- `heading_deg` is true, clockwise from north.
- `pitch_deg` is positive nose up.
- `bank_deg` is positive with the right wing down.
- `alt_m` is above mean sea level.

## What it does

1. **Reads the installed SDK's `SimConnect.h`.** It takes the enum values
   from there: message IDs, the World referential, the camera mask, the
   locker and camera states. It checks that `SIMCONNECT_DATA_CAMERA`,
   `SIMCONNECT_DATA_XYZ`, `SIMCONNECT_DATA_PBH` and the camera's receive
   structs still have the members the bridge marshals, in the same order, at
   1-byte packing. It refuses to run if they don't (exit code 3).
2. **Acquires the add-on camera.** It calls `SimConnect_Open`, subscribes to
   the camera and world-locker status, calls `SimConnect_CameraAcquire`, and
   waits until the camera is the bridge's and not under the sim's control.
3. **Locks the world at the start.** `SimConnect_RequestCameraWorldLocker`
   (World referential, the first sample) loads the scenery there, and the
   bridge waits for `SUCCESS`. Then it holds the first pose for `--settle`
   seconds.
4. **Flies the path.** `SimConnect_CameraSet` runs every frame with
   `ALL_ROTATION`: position in the World referential (x latitude, y
   longitude, z altitude), and pitch, bank and heading in the World
   referential, with the FOV in radians.
   - Frames are due on a monotonic clock (`Stopwatch`, Windows timer at
     1 ms). A late step sends the frame the clock is at and skips the ones it
     missed, so the path never slows down.
   - The clock stops while the camera isn't the bridge's (the sim's menus or
     pause, another client, the user) and resumes where it was.
5. **Records (`--record`).** OBS's built-in WebSocket server (obs-websocket
   v5) gets `StartRecord` before the flight and `StopRecord` after it, and the
   bridge prints the file's path.
6. **Releases on exit.** `SimConnect_DeleteCameraWorldLocker`,
   `SimConnect_CameraRelease("")` (back to the camera before) and
   `SimConnect_Close`. This also happens on Ctrl+C, on an error, and when
   the console window is closed.

It calls the native `SimConnect.dll` from the SDK, not the managed
`Microsoft.FlightSimulator.SimConnect.dll` wrapper. The camera API is
marked beta, the wrapper's coverage of it isn't confirmed, and the native
calls let the bridge lay out the structs itself and check them against the
header.

## Build

Needs the .NET 8 SDK and the MSFS 2024 SDK. Nothing of the SDK is
committed; the build copies `SimConnect.dll` from it.

```bash
dotnet build -c Release -p:MsfsSdk="C:\MSFS 2024 SDK"
```

The SDK root can also come from the `MSFS2024_SDK` or `MSFS_SDK`
environment variable. The output is
`bin/Release/net8.0/gev-bridge.exe`, with `SimConnect.dll` beside it.
Without an SDK, the build warns and the dry run still works.

## Run (on the cloud machine)

1. **Prepare the sim.** Start MSFS 2024 and load a free flight anywhere, so
   the user aircraft exists; the locker loads the path's start. In the sim's
   camera options, leave the add-on camera allowed: a user-disabled camera
   shows as `USER_DISABLED`.
2. **Check the SDK.** `gev-bridge --check-header --sdk "C:\MSFS 2024 SDK"`
   prints the struct members and the values it read, and returns 3 on a
   mismatch.
3. **Check the attitude, once per SDK version.** `gev-bridge baltimore.json
--attitude-test` holds the start, then pitches +15°, banks +15° and turns
   +90° for 3 s each. Its log says what you should see. The signs and units
   are not documented, so set `--pitch-sign -1`, `--bank-sign -1`,
   `--heading-offset` or `--alt-units ft` from what it shows.
4. **Fly it.** Run `gev-bridge baltimore.json --record` (with the flags from
   step 3). Ctrl+C stops it and releases the camera.

To try a path file without a sim, on any machine with .NET:

```bash
gev-bridge baltimore.json --dry-run
```

It validates the file and replays it in real time, printing one sample a
second. `--every N` prints every N frames instead, and `--fast` replays
without waiting.

Exit codes: 0 done, 1 error, 2 usage, 3 the header doesn't match, 130
stopped.

## OBS

1. Tools > WebSocket Server Settings: enable the server (port 4455) and set
   a password.
2. In the shell that runs the bridge, set the password:
   `$env:OBS_WEBSOCKET_PASSWORD = "..."`. It is never passed on the command
   line. Use `--obs ws://127.0.0.1:4455` for another port.
3. Add a Game Capture (or Display Capture) of MSFS. Output: NVENC (the
   A10G), for example 1920×1080 at 60 fps.
4. Record to the instance's NVMe disk, which is fast but erased on stop.
   Copy what you keep to the volume or download it.

## Known risks

- **The camera API is beta** ("may be subject to change"). The struct
  layout must match the installed SDK's headers. The layout is reported to
  have changed in SDK 1.6.6; no release note confirming that was found, so
  the bridge checks the header on every live run (`--check-header`) instead
  of trusting it.
- **World referential and look-at.** On the developer forum, Asobo confirmed
  "a mistake in the referential computation" for the _targeted_ (look-at)
  mask in the World referential, to be fixed during SU5 flighting. A later
  report has the camera inheriting the aircraft's roll with `ALL_TARGETED`.
  The bridge never uses the targeted mask, only explicit pitch, bank and
  heading (`ALL_ROTATION`). If a build has the same problem with rotation,
  the attitude test shows it.
- **World lockers are heavy.** The docs say they are "very resource
  intensive" and should be removed as soon as possible. The bridge places
  one, at the start, and deletes it on exit. Along a long path the sim
  streams scenery as the camera moves, and slow or distant scenery may pop
  in. Fly slower, or fly the path once before recording.
- **The camera can be taken.** Acquisition is a queue: another add-on can
  "steal" the camera, and the user can revoke it from the sim's camera
  panel. The bridge's clock stops until the camera is back, and logs who
  holds it; OBS keeps recording through that gap. Close other camera
  add-ons before recording.
- **Not documented, so check with the attitude test:**
  - The World referential's altitude unit (metres is assumed).
  - The signs of pitch and bank in the camera's `Pbh`.
  - Whether the FOV is horizontal or vertical.
- **Not compiled here.** The PC this was written on has no .NET SDK. Build
  it on the cloud machine first; the dry run and `--check-header` are the
  first tests.
