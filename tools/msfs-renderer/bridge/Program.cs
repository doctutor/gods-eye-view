// Personal fork: gev-bridge, MSFS 2024's add-on camera flown along a GEV
// camera path (README.md).
//
//   gev-bridge <path.json> --dry-run [--fast] [--every N]
//   gev-bridge --check-header [--sdk DIR]
//   gev-bridge --obs-check [--obs URL] [--obs-password-file FILE]
//   gev-bridge <path.json> [--sdk DIR] [--record] [--obs ws://127.0.0.1:4455]
//              [--obs-password-file FILE] [--no-locker] [--locker-timeout S]
//              [--settle S] [--pitch-sign 1|-1] [--bank-sign 1|-1]
//              [--heading-offset DEG] [--alt-units m|ft] [--attitude-test]
//   gev-bridge <path.json> --stills [--every-s N] [--out DIR] [--dry-run] [...]
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace GevBridge;

internal sealed class Options
{
    public string? PathFile;
    public bool DryRun, Fast, Record, NoLocker, CheckHeader, AttitudeTest, Stills, ObsCheck;
    public int Every;
    public double EveryS;
    public string? Sdk;
    public Uri Obs = new("ws://127.0.0.1:4455");
    // Where airgpu-setup.ps1 keeps the OBS WebSocket password it generated.
    public string ObsPasswordFile = @"C:\gev\obs-websocket.txt";
    public string StillsDir = @"C:\gev\recordings";
    // PitchSign -1: on MSFS 2024 with SDK 1.8.1 the attitude test tilted DOWN for
    // +15°, so a positive camera pitch is nose-down (as the sim's PBH is);
    // bank and heading matched. Measured on the AirGPU machine, 2026-10-22.
    public double LockerTimeout = 180, Settle = 3, PitchSign = -1, BankSign = 1, HeadingOffset, AltFactor = 1;

    public CameraOptions Camera => new(PitchSign, BankSign, HeadingOffset, AltFactor);

    public static Options Parse(string[] args)
    {
        var o = new Options();
        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            string Value() => i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal)
                ? args[++i]
                : throw new ArgumentException($"{arg} needs a value");
            double Number() => double.TryParse(Value(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && double.IsFinite(v)
                ? v
                : throw new ArgumentException($"{arg} takes a number");
            double Sign() => Number() switch { 1 => 1, -1 => -1, _ => throw new ArgumentException($"{arg} is 1 or -1") };
            switch (arg)
            {
                case "--dry-run": o.DryRun = true; break;
                case "--fast": o.Fast = true; break;
                case "--every": o.Every = (int)Number(); break;
                case "--sdk": o.Sdk = Value(); break;
                case "--record": o.Record = true; break;
                case "--stills": o.Stills = true; break;
                case "--every-s": o.EveryS = Number(); break;
                case "--out": o.StillsDir = Value(); break;
                case "--obs-password-file": o.ObsPasswordFile = Value(); break;
                case "--obs-check": o.ObsCheck = true; break;
                case "--obs": o.Obs = Uri.TryCreate(Value(), UriKind.Absolute, out var u) && (u.Scheme == "ws" || u.Scheme == "wss") ? u : throw new ArgumentException("--obs takes ws://host:port"); break;
                case "--no-locker": o.NoLocker = true; break;
                case "--locker-timeout": o.LockerTimeout = Number(); break;
                case "--settle": o.Settle = Number(); break;
                case "--pitch-sign": o.PitchSign = Sign(); break;
                case "--bank-sign": o.BankSign = Sign(); break;
                case "--heading-offset": o.HeadingOffset = Number(); break;
                case "--alt-units":
                    o.AltFactor = Value() switch { "m" => 1, "ft" => 3.28084, _ => throw new ArgumentException("--alt-units is m or ft") };
                    break;
                case "--check-header": o.CheckHeader = true; break;
                case "--attitude-test": o.AttitudeTest = true; break;
                default:
                    if (arg.StartsWith("--", StringComparison.Ordinal) || o.PathFile is not null) throw new ArgumentException($"unknown argument {arg}");
                    o.PathFile = arg;
                    break;
            }
        }
        if (!o.CheckHeader && !o.ObsCheck && o.PathFile is null) throw new ArgumentException("a camera path file is needed");
        if (o.DryRun && o.Record) throw new ArgumentException("--record needs a live run, not --dry-run");
        if (o.Stills && o.Record) throw new ArgumentException("--stills and --record are separate runs");
        if (o.Stills && o.AttitudeTest) throw new ArgumentException("--stills and --attitude-test are separate runs");
        if (o.EveryS != 0 && !o.Stills) throw new ArgumentException("--every-s goes with --stills");
        if (o.EveryS < 0) throw new ArgumentException("--every-s is positive");
        if (o.Settle < 0 || o.LockerTimeout <= 0) throw new ArgumentException("--settle and --locker-timeout are positive");
        return o;
    }

    /// <summary>The OBS WebSocket password: OBS_WEBSOCKET_PASSWORD when set, else the password file's first line, else none.</summary>
    public string? ObsPassword(Func<string, string?>? env = null)
    {
        var fromEnv = (env ?? Environment.GetEnvironmentVariable)("OBS_WEBSOCKET_PASSWORD");
        if (!string.IsNullOrEmpty(fromEnv)) return fromEnv;
        if (!File.Exists(ObsPasswordFile)) return null;
        var line = File.ReadLines(ObsPasswordFile).FirstOrDefault()?.Trim();
        return string.IsNullOrEmpty(line) ? null : line;
    }
}

internal static class Program
{
    private const string Usage =
        "usage: gev-bridge <path.json> --dry-run [--fast] [--every N]\n" +
        "       gev-bridge --check-header [--sdk DIR]\n" +
        "       gev-bridge --obs-check [--obs URL] [--obs-password-file FILE]\n" +
        "       gev-bridge <path.json> --stills [--every-s N] [--out DIR] [--settle S] [--dry-run]\n" +
        "       gev-bridge <path.json> [--sdk DIR] [--record] [--obs ws://127.0.0.1:4455] [--no-locker] [--locker-timeout S] [--settle S]\n" +
        "                  [--pitch-sign 1|-1] [--bank-sign 1|-1] [--heading-offset DEG] [--alt-units m|ft] [--attitude-test]";

    private static void Log(string line) => Console.WriteLine($"{DateTime.Now:HH:mm:ss.fff} {line}");

    private static async Task<int> Main(string[] args)
    {
        Options options;
        try
        {
            options = Options.Parse(args);
        }
        catch (ArgumentException error)
        {
            Console.Error.WriteLine(error.Message);
            Console.Error.WriteLine(Usage);
            return 2;
        }
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            // Ctrl+C: stop the playback; the finally blocks release the camera.
            e.Cancel = true;
            Log("stopping (Ctrl+C)");
            cts.Cancel();
        };
        try
        {
            if (options.CheckHeader) return CheckHeader(options);
            if (options.ObsCheck) return await ObsCheck(options, cts.Token);
            var path = LoadPath(options.PathFile!);
            if (path is null) return 1;
            if (options.Stills && options.DryRun) return StillsDryRun(path, options);
            return options.DryRun ? DryRun(path, options, cts.Token) : await Live(path, options, cts.Token);
        }
        catch (OperationCanceledException)
        {
            Log("stopped");
            return 130;
        }
        catch (DllNotFoundException)
        {
            Console.Error.WriteLine("gev-bridge: SimConnect.dll not found: build with the MSFS 2024 SDK (README.md) or copy it from <SDK>\\SimConnect SDK\\lib beside gev-bridge.exe");
            return 1;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"gev-bridge: {error.Message}");
            return 1;
        }
    }

    private static CameraPathFile? LoadPath(string file)
    {
        CameraPathFile path;
        try
        {
            path = CameraPathFile.Load(file);
        }
        catch (JsonException error)
        {
            Console.Error.WriteLine($"{file}: not JSON ({error.Message})");
            return null;
        }
        var problems = path.Validate();
        if (problems.Count > 0)
        {
            Console.Error.WriteLine($"{file}: not a valid camera path:");
            foreach (var problem in problems) Console.Error.WriteLine($"  {problem}");
            return null;
        }
        string mode = path.Meta is JsonElement meta && meta.ValueKind == JsonValueKind.Object && meta.TryGetProperty("mode", out var m) ? m.ToString() : "?";
        Log($"{file}: {path.Count:N0} samples at {path.Fps} fps, {path.Duration:0.0} s, mode {mode}; from {path.First.Lat:0.00000},{path.First.Lon:0.00000} at {path.First.AltM:0} m");
        return path;
    }

    private static string Describe(Pose p) => string.Create(CultureInfo.InvariantCulture,
        $"t {p.T,8:0.000}  {p.Lat,11:0.0000000} {p.Lon,12:0.0000000}  alt {p.AltM,7:0.0} m  hdg {p.HeadingDeg,6:0.00}  pitch {p.PitchDeg,6:0.00}  bank {p.BankDeg,6:0.00}  fov {p.FovDeg:0.#}");

    /// <summary>Validate and replay without a sim: every Nth frame printed, the clock's skipped frames counted.</summary>
    private static int DryRun(CameraPathFile path, Options options, CancellationToken ct)
    {
        int every = options.Every > 0 ? options.Every : Math.Max(1, (int)Math.Round(path.Fps!.Value));
        var stats = Playback.Run(path, (frame, pose) =>
        {
            if (frame % every == 0 || frame == (long)Math.Floor(path.Duration * path.Fps!.Value + 1e-6)) Console.WriteLine(Describe(pose));
        }, null, null, realTime: !options.Fast, ct);
        Log($"dry run: {stats.Sent:N0} of {stats.Frames:N0} frames sent, {stats.Skipped:N0} skipped, {stats.Seconds:0.00} s");
        return 0;
    }

    /// <summary>The stills' plan and file names, without a sim or OBS.</summary>
    private static int StillsDryRun(CameraPathFile path, Options options)
    {
        var plan = Stills.Plan(path, options.EveryS);
        if (plan.Count == 0)
        {
            Console.Error.WriteLine("no stills: the path's meta names no waypoints; use --every-s N");
            return 1;
        }
        var run = DateTime.Now;
        for (int i = 0; i < plan.Count; i++)
        {
            var pose = path.At(plan[i].T);
            Console.WriteLine($"{Describe(pose)}  -> {Stills.FileName(options.StillsDir, options.PathFile!, run, i + 1, plan[i], pose)}");
        }
        Log($"stills dry run: {plan.Count} stills, {options.Settle:0.#} s settle each");
        return 0;
    }

    /// <summary>OBS reachable with the stored password: its versions, canvas and output, scene, recording folder and encoder.</summary>
    private static async Task<int> ObsCheck(Options options, CancellationToken ct)
    {
        await using var obs = await ObsRecorder.ConnectAsync(options.Obs, options.ObsPassword(), ct);
        var version = await obs.RequestAsync("GetVersion", ct);
        var video = await obs.RequestAsync("GetVideoSettings", ct);
        var scene = ObsRequests.ProgramSceneName(await obs.RequestAsync("GetCurrentProgramScene", ct));
        var folder = await obs.RequestAsync("GetRecordDirectory", ct);
        var encoder = await obs.RequestAsync("GetProfileParameter", ct, ObsRequests.ProfileParameter("AdvOut", "RecEncoder"));
        Log($"OBS {version?["obsVersion"]}, obs-websocket {version?["obsWebSocketVersion"]}: identified");
        Log($"canvas {video?["baseWidth"]}x{video?["baseHeight"]}, output {video?["outputWidth"]}x{video?["outputHeight"]} at {video?["fpsNumerator"]}/{video?["fpsDenominator"]} fps");
        Log($"scene {scene ?? "?"}; recording to {folder?["recordDirectory"]} with {encoder?["parameterValue"]}");
        return 0;
    }

    private static int CheckHeader(Options options)
    {
        var file = SimConnectHeader.Find(options.Sdk);
        if (file is null)
        {
            Console.Error.WriteLine("No SimConnect.h: --sdk <MSFS 2024 SDK root>, or set MSFS2024_SDK");
            return 1;
        }
        var header = new SimConnectHeader(file);
        var (problems, notes) = header.CheckLayout();
        Log(file);
        foreach (var note in notes) Console.WriteLine($"  ok: {note}");
        foreach (var problem in problems) Console.WriteLine($"  MISMATCH: {problem}");
        Console.WriteLine($"  the bridge's SIMCONNECT_DATA_CAMERA: {Marshal.SizeOf<SimConnectCamera>()} bytes; Pbh at {Marshal.OffsetOf<SimConnectCamera>("Pbh")}, Fov at {Marshal.OffsetOf<SimConnectCamera>("Fov")}");
        if (problems.Count > 0) return 3;
        var ids = SimConnectIds.From(header);
        Console.WriteLine($"  RECV_ID: exception {ids.RecvException}, open {ids.RecvOpen}, quit {ids.RecvQuit}, camera status {ids.RecvCameraStatus}, world locker {ids.RecvCameraWorldLocker}");
        Console.WriteLine($"  World referential {ids.ReferentialWorld}; mask ALL_ROTATION 0x{ids.MaskAllRotation:X2}; locker success/cancel/fail {ids.LockerSuccess}/{ids.LockerCancel}/{ids.LockerFail}");
        Console.WriteLine($"  camera states: {(ids.AcquiredStates.Count > 0 ? string.Join(", ", ids.AcquiredStates.Select(p => $"{p.Value}={p.Key}")) : "not named in the header (ACQUIRED taken as 1)")}");
        return 0;
    }

    private static async Task<int> Live(CameraPathFile path, Options options, CancellationToken ct)
    {
        var file = SimConnectHeader.Find(options.Sdk)
            ?? throw new InvalidOperationException("No SimConnect.h: --sdk <MSFS 2024 SDK root>, or set MSFS2024_SDK (the bridge reads the camera API's values from it)");
        var header = new SimConnectHeader(file);
        var (problems, _) = header.CheckLayout();
        if (problems.Count > 0)
        {
            Console.Error.WriteLine("SimConnect.h does not match the bridge's camera structs (SimConnectNative.cs); update them first:");
            foreach (var problem in problems) Console.Error.WriteLine($"  {problem}");
            return 3;
        }
        var ids = SimConnectIds.From(header);
        var camera = options.Camera;
        ObsRecorder? obs = null;
        bool recording = false;
        using var session = new SimSession(ids, Log);
        // Closing the console window: release the camera too.
        AppDomain.CurrentDomain.ProcessExit += (_, _) => session.Dispose();
        try
        {
            session.Open("GEV bridge", TimeSpan.FromSeconds(15), ct);
            session.Acquire("GEV bridge", TimeSpan.FromSeconds(30), ct);
            session.Set(path.First, camera);
            if (!options.NoLocker)
                session.Lock(path.First, camera, TimeSpan.FromSeconds(options.LockerTimeout), ct);
            Hold(session, path.First, camera, options.Settle, ct);

            if (options.AttitudeTest)
            {
                AttitudeTest(session, path.First, camera, ct);
                return 0;
            }
            if (options.Stills)
            {
                obs = await ObsRecorder.ConnectAsync(options.Obs, options.ObsPassword(), ct);
                return await TakeStills(session, obs, path, options, ct);
            }
            JsonNode? statsBefore = null;
            if (options.Record)
            {
                obs = await ObsRecorder.ConnectAsync(options.Obs, options.ObsPassword(), ct);
                await obs.RequestAsync("StartRecord", ct);
                recording = true;
                statsBefore = await obs.RequestAsync("GetStats", ct);
                Log("OBS recording");
                Hold(session, path.First, camera, 1, ct); // OBS's first frames
            }
            Log($"flying {path.Duration:0.0} s");
            var stats = Playback.Run(path, (_, pose) => session.Set(pose, camera), session.Dispatch, () => session.Controllable && !session.Quit, realTime: true, ct);
            Log($"done: {stats.Sent:N0} of {stats.Frames:N0} frames set, {stats.Skipped:N0} skipped, {stats.Seconds:0.0} s ({stats.PausedSeconds:0.0} s paused while the camera was not ours)");
            Hold(session, path.Last, camera, 1, ct);
            if (obs is not null && statsBefore is not null)
                Log(FrameStats(statsBefore, await obs.RequestAsync("GetStats", ct)));
            return session.Quit ? 1 : 0;
        }
        finally
        {
            if (recording && obs is not null)
            {
                try
                {
                    var data = await obs.RequestAsync("StopRecord", CancellationToken.None);
                    Log($"OBS stopped: {data?["outputPath"]?.ToString() ?? "(no path)"}");
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine($"OBS StopRecord: {error.Message} (stop it by hand)");
                }
            }
            if (obs is not null) await obs.DisposeAsync();
        }
    }

    /// <summary>OBS's frames during the recording: how many it could not render (the GPU was busy) or encode in time.</summary>
    internal static string FrameStats(JsonNode before, JsonNode? after)
    {
        long Delta(string key) => (after?[key]?.GetValue<long>() ?? 0) - (before[key]?.GetValue<long>() ?? 0);
        return $"OBS during the flight: {Delta("renderSkippedFrames"):N0} of {Delta("renderTotalFrames"):N0} frames not rendered in time (GPU busy), " +
            $"{Delta("outputSkippedFrames"):N0} of {Delta("outputTotalFrames"):N0} not encoded in time";
    }

    /// <summary>
    /// --stills: at each planned moment, the camera set there (a world locker
    /// there too, unless --no-locker), held --settle seconds, then OBS saves
    /// the program scene as a PNG at the canvas's size.
    /// </summary>
    private static async Task<int> TakeStills(SimSession session, ObsRecorder obs, CameraPathFile path, Options options, CancellationToken ct)
    {
        var plan = Stills.Plan(path, options.EveryS);
        if (plan.Count == 0) throw new InvalidOperationException("no stills: the path's meta names no waypoints; use --every-s N");
        var scene = ObsRequests.ProgramSceneName(await obs.RequestAsync("GetCurrentProgramScene", ct))
            ?? throw new InvalidOperationException("OBS has no program scene");
        Directory.CreateDirectory(options.StillsDir);
        var run = DateTime.Now;
        var camera = options.Camera;
        for (int i = 0; i < plan.Count; i++)
        {
            var pose = path.At(plan[i].T);
            session.Set(pose, camera);
            if (!options.NoLocker)
                session.Lock(pose, camera, TimeSpan.FromSeconds(options.LockerTimeout), ct, $"still {i + 1}");
            Hold(session, pose, camera, options.Settle, ct);
            var file = Path.GetFullPath(Stills.FileName(options.StillsDir, options.PathFile!, run, i + 1, plan[i], pose));
            await obs.RequestAsync("SaveSourceScreenshot", ct, ObsRequests.SaveSourceScreenshot(scene, file));
            Log($"still {i + 1} of {plan.Count} ({plan[i].Label}): {file}");
        }
        return session.Quit ? 1 : 0;
    }

    /// <summary>Hold a pose for some seconds, reading SimConnect's messages.</summary>
    private static void Hold(SimSession session, Pose pose, CameraOptions camera, double seconds, CancellationToken ct)
    {
        var until = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < until)
        {
            ct.ThrowIfCancellationRequested();
            session.Dispatch();
            if (session.Controllable) session.Set(pose, camera);
            Thread.Sleep(33);
        }
    }

    /// <summary>The signs and units checked by eye: the start pose, then pitched, banked and turned, 3 s each.</summary>
    private static void AttitudeTest(SimSession session, Pose start, CameraOptions camera, CancellationToken ct)
    {
        var steps = new (string Say, Pose Pose)[]
        {
            ($"the start: {start.AltM:0} m above sea level (if the view is far too low or high, try --alt-units ft)", start),
            ("pitch +15°: the view should tilt UP (if it tilts down, use --pitch-sign -1)", start with { PitchDeg = start.PitchDeg + 15 }),
            ("bank +15°: the RIGHT wing should go down, the horizon tilting left-up (if not, use --bank-sign -1)", start with { BankDeg = start.BankDeg + 15 }),
            ($"heading {start.HeadingDeg:0}° → +90°: the view should turn RIGHT, to the east of the start heading (if the start heading is off, set --heading-offset)", start with { HeadingDeg = start.HeadingDeg + 90 }),
        };
        foreach (var (say, pose) in steps)
        {
            Log(say);
            Hold(session, pose, camera, 3, ct);
        }
    }
}
