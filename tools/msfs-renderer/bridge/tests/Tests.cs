// Personal fork: the bridge's checks (GevBridge.Tests.csproj). Each test is
// a method; a failed Check prints what and where, and the run exits 1.
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using GevBridge;

int failures = 0;
int checks = 0;

void Check(bool ok, string what, [CallerLineNumber] int line = 0)
{
    checks++;
    if (ok) return;
    failures++;
    Console.WriteLine($"FAIL (Tests.cs:{line}) {what}");
}

void Throws<T>(Action action, string what, [CallerLineNumber] int line = 0) where T : Exception
{
    try
    {
        action();
        Check(false, $"{what}: no {typeof(T).Name}", line);
    }
    catch (T)
    {
        Check(true, what, line);
    }
}

// A camera path file: two minutes along a line, waypoints in its meta.
string WritePath(string meta)
{
    var file = Path.Combine(Path.GetTempPath(), $"gev-bridge-test-{Guid.NewGuid():N}.json");
    var samples = string.Join(",", Enumerable.Range(0, 121).Select(i =>
        FormattableString.Invariant($"{{\"t\":{i},\"lat\":{39.29 + i * 0.0003},\"lon\":-76.61,\"alt_m\":300,\"heading_deg\":0,\"pitch_deg\":0,\"bank_deg\":0,\"fov_deg\":60}}")));
    File.WriteAllText(file, $"{{\"version\":1,\"fps\":1,\"samples\":[{samples}],\"meta\":{meta}}}");
    return file;
}

CameraPathFile Load(string file)
{
    var path = CameraPathFile.Load(file);
    Check(path.Validate().Count == 0, "the test path is valid");
    return path;
}

// --- arguments ----------------------------------------------------------------

{
    var o = Options.Parse(new[] { "route.json", "--record" });
    Check(o.Record && o.PathFile == "route.json", "--record with a path");
    Check(o.ObsPasswordFile == @"C:\gev\obs-websocket.txt", "the password file defaults to what airgpu-setup.ps1 writes");
    Check(o.StillsDir == @"C:\gev\recordings", "stills go to the recordings folder by default");
    Check(o.PitchSign == -1, "pitch sign -1 by default (measured on MSFS 2024)");

    var stills = Options.Parse(new[] { "route.json", "--stills", "--every-s", "10", "--out", @"D:\stills", "--settle", "8" });
    Check(stills.Stills && stills.EveryS == 10 && stills.StillsDir == @"D:\stills" && stills.Settle == 8, "--stills with --every-s, --out and --settle");
    Check(Options.Parse(new[] { "route.json", "--stills", "--dry-run" }).DryRun, "--stills --dry-run plans without a sim");

    var check = Options.Parse(new[] { "--obs-check", "--obs-password-file", @"C:\elsewhere.txt" });
    Check(check.ObsCheck && check.PathFile is null && check.ObsPasswordFile == @"C:\elsewhere.txt", "--obs-check needs no path");

    Throws<ArgumentException>(() => Options.Parse(new[] { "route.json", "--stills", "--record" }), "--stills and --record together");
    Throws<ArgumentException>(() => Options.Parse(new[] { "route.json", "--every-s", "5" }), "--every-s without --stills");
    Throws<ArgumentException>(() => Options.Parse(new[] { "route.json", "--stills", "--every-s", "-1" }), "a negative --every-s");
    Throws<ArgumentException>(() => Options.Parse(new[] { "route.json", "--stills", "--attitude-test" }), "--stills with --attitude-test");
    Throws<ArgumentException>(() => Options.Parse(new[] { "--record" }), "no path");
    Throws<ArgumentException>(() => Options.Parse(new[] { "route.json", "--obs-password-file" }), "--obs-password-file without a value");
}

// --- the OBS password -------------------------------------------------------

{
    var file = Path.Combine(Path.GetTempPath(), $"gev-obs-{Guid.NewGuid():N}.txt");
    File.WriteAllText(file, "s3cret-from-file\r\n");
    var o = Options.Parse(new[] { "--obs-check", "--obs-password-file", file });
    Check(o.ObsPassword(_ => null) == "s3cret-from-file", "the password file's first line, trimmed");
    Check(o.ObsPassword(_ => "from-env") == "from-env", "OBS_WEBSOCKET_PASSWORD wins over the file");
    Check(o.ObsPassword(_ => "") == "s3cret-from-file", "an empty OBS_WEBSOCKET_PASSWORD is ignored");
    File.Delete(file);
    Check(o.ObsPassword(_ => null) is null, "no file and no variable: no password");
}

// --- the OBS requests ---------------------------------------------------------

{
    var start = ObsRequests.Request("StartRecord", "gev-1");
    Check(start.ToJsonString() == "{\"op\":6,\"d\":{\"requestType\":\"StartRecord\",\"requestId\":\"gev-1\"}}", $"StartRecord: {start.ToJsonString()}");

    var png = OperatingSystem.IsWindows() ? @"C:\gev\recordings\a.png" : "/tmp/a.png";
    var shot = ObsRequests.Request("SaveSourceScreenshot", "gev-2", ObsRequests.SaveSourceScreenshot("GEV", png));
    var d = shot["d"]!;
    Check(d["requestType"]!.GetValue<string>() == "SaveSourceScreenshot", "the screenshot request's type");
    var data = d["requestData"]!.AsObject();
    Check(data["sourceName"]!.GetValue<string>() == "GEV" && data["imageFormat"]!.GetValue<string>() == "png" && data["imageFilePath"]!.GetValue<string>() == png,
        $"the screenshot's source, format and path: {data.ToJsonString()}");
    Check(!data.ContainsKey("imageWidth") && !data.ContainsKey("imageHeight"), "no size: the scene's own (the canvas)");
    var sized = ObsRequests.SaveSourceScreenshot("GEV", png, 3840, 2160);
    Check(sized["imageWidth"]!.GetValue<int>() == 3840 && sized["imageHeight"]!.GetValue<int>() == 2160, "a size when asked");
    Throws<ArgumentException>(() => ObsRequests.SaveSourceScreenshot("GEV", "relative.png"), "a relative screenshot path");

    var parameter = ObsRequests.ProfileParameter("AdvOut", "RecEncoder");
    Check(parameter.ToJsonString() == "{\"parameterCategory\":\"AdvOut\",\"parameterName\":\"RecEncoder\"}", $"GetProfileParameter: {parameter.ToJsonString()}");

    Check(ObsRequests.ProgramSceneName(JsonNode.Parse("{\"sceneName\":\"GEV\",\"sceneUuid\":\"x\"}")) == "GEV", "the program scene (5.5+)");
    Check(ObsRequests.ProgramSceneName(JsonNode.Parse("{\"currentProgramSceneName\":\"Old\"}")) == "Old", "the program scene (5.0 to 5.4)");
    Check(ObsRequests.ProgramSceneName(null) is null, "no program scene");

    // obs-websocket v5: base64(sha256(base64(sha256(password + salt)) + challenge)).
    var auth = ObsRecorder.Authentication("supersecretpassword", "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=", "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=");
    var again = ObsRecorder.Authentication("supersecretpassword", "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=", "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=");
    Check(auth == again && Convert.FromBase64String(auth).Length == 32, "the authentication string is a stable base64 SHA-256");

    var stats = GevBridge.Program.FrameStats(
        JsonNode.Parse("{\"renderSkippedFrames\":2,\"renderTotalFrames\":1000,\"outputSkippedFrames\":0,\"outputTotalFrames\":900}")!,
        JsonNode.Parse("{\"renderSkippedFrames\":5,\"renderTotalFrames\":7000,\"outputSkippedFrames\":1,\"outputTotalFrames\":6900}"));
    Check(stats.Contains("3 of 6,000 frames not rendered") && stats.Contains("1 of 6,000 not encoded"), $"the frame stats: {stats}");
}

// --- stills -------------------------------------------------------------------

{
    var file = WritePath("{\"from\":{\"lat\":39.29,\"lon\":-76.61},\"via\":[{\"lat\":39.302,\"lon\":-76.61}],\"to\":{\"lat\":39.326,\"lon\":-76.61}}");
    var path = Load(file);
    var waypoints = Stills.Plan(path, 0);
    Check(waypoints.Count == 3, $"one still a waypoint: {waypoints.Count}");
    Check(waypoints.Select(s => s.Label).SequenceEqual(new[] { "from", "via1", "to" }), "the waypoints' labels");
    Check(Math.Abs(waypoints[0].T) < 1e-9 && Math.Abs(waypoints[1].T - 40) < 1e-9 && Math.Abs(waypoints[2].T - 120) < 1e-9,
        $"each at its nearest sample: {string.Join(", ", waypoints.Select(s => s.T))}");

    var every = Stills.Plan(path, 50);
    Check(every.Select(s => s.T).SequenceEqual(new[] { 0.0, 50, 100, 120 }), $"every 50 s and the end: {string.Join(", ", every.Select(s => s.T))}");
    Check(every[^1].Label == "end", "the last one is the end");
    Check(Stills.Plan(path, 60).Select(s => s.T).SequenceEqual(new[] { 0.0, 60, 120 }), "the end not doubled when it falls on a step");

    var none = Load(WritePath("{}"));
    Check(Stills.Plan(none, 0).Count == 0, "no waypoints in the meta: no stills");

    var pose = path.At(40);
    var route = OperatingSystem.IsWindows() ? @"C:\gev\paths\baltimore route.json" : "/gev/paths/baltimore route.json";
    var name = Path.GetFileName(Stills.FileName(Path.GetTempPath(), route, new DateTime(2026, 10, 23, 10, 15, 0), 2, waypoints[1], pose));
    Check(name == "baltimore_route_20261023-101500_02_via1_t0040.000s_39.30200_-76.61000.png", $"the still's name: {name}");
    File.Delete(file);
}

Console.WriteLine(failures == 0 ? $"ok: {checks} checks" : $"{failures} of {checks} checks failed");
return failures == 0 ? 0 : 1;
