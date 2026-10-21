// Personal fork: a camera path file (version 1, scripts/msfs/cameraPath.mjs):
// loaded, checked like validatePath there, and read at any time between its
// samples. Angles: heading true clockwise from north, pitch positive nose
// up, bank positive right wing down; alt_m above mean sea level.
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GevBridge;

public sealed class PathSample
{
    [JsonPropertyName("t")] public double? T { get; set; }
    [JsonPropertyName("lat")] public double? Lat { get; set; }
    [JsonPropertyName("lon")] public double? Lon { get; set; }
    [JsonPropertyName("alt_m")] public double? AltM { get; set; }
    [JsonPropertyName("heading_deg")] public double? HeadingDeg { get; set; }
    [JsonPropertyName("pitch_deg")] public double? PitchDeg { get; set; }
    [JsonPropertyName("bank_deg")] public double? BankDeg { get; set; }
    [JsonPropertyName("fov_deg")] public double? FovDeg { get; set; }
}

/// <summary>A pose at a moment: what the camera is set to.</summary>
public readonly record struct Pose(double T, double Lat, double Lon, double AltM, double HeadingDeg, double PitchDeg, double BankDeg, double FovDeg);

public sealed class CameraPathFile
{
    public const int Version1 = 1;

    [JsonPropertyName("version")] public int? Version { get; set; }
    [JsonPropertyName("fps")] public double? Fps { get; set; }
    [JsonPropertyName("samples")] public List<PathSample>? Samples { get; set; }
    [JsonPropertyName("meta")] public JsonElement? Meta { get; set; }

    private Pose[] _poses = Array.Empty<Pose>();

    public static CameraPathFile Load(string file)
    {
        var json = File.ReadAllText(file);
        var path = JsonSerializer.Deserialize<CameraPathFile>(json)
            ?? throw new InvalidDataException($"{file}: not a camera path");
        return path;
    }

    /// <summary>The file's problems (empty when valid); on success the poses are ready.</summary>
    public List<string> Validate()
    {
        var problems = new List<string>();
        if (Version != Version1) problems.Add($"version {Version?.ToString() ?? "missing"} is not {Version1}");
        if (!(Fps > 0)) problems.Add("fps must be positive");
        var samples = Samples ?? new List<PathSample>();
        if (samples.Count < 2) problems.Add("fewer than two samples");
        var poses = new Pose[samples.Count];
        double last = double.NegativeInfinity;
        for (int i = 0; i < samples.Count && problems.Count <= 20; i++)
        {
            var s = samples[i];
            if (s.T is not double t || !(t > last)) problems.Add($"sample {i}: t {s.T} does not increase");
            last = s.T ?? last;
            if (!(Math.Abs(s.Lat ?? 999) <= 90 && Math.Abs(s.Lon ?? 999) <= 180)) problems.Add($"sample {i}: lat/lon out of range");
            foreach (var (name, value) in new[] { ("alt_m", s.AltM), ("heading_deg", s.HeadingDeg), ("pitch_deg", s.PitchDeg), ("bank_deg", s.BankDeg), ("fov_deg", s.FovDeg) })
                if (value is not double v || !double.IsFinite(v)) problems.Add($"sample {i}: {name} is not a number");
            if (!(s.FovDeg > 0 && s.FovDeg < 180)) problems.Add($"sample {i}: fov_deg out of range");
            if (problems.Count == 0)
                poses[i] = new Pose(s.T!.Value, s.Lat!.Value, s.Lon!.Value, s.AltM!.Value, s.HeadingDeg!.Value, s.PitchDeg!.Value, s.BankDeg!.Value, s.FovDeg!.Value);
        }
        if (problems.Count == 0) _poses = poses;
        return problems;
    }

    public int Count => _poses.Length;
    public double Duration => _poses.Length == 0 ? 0 : _poses[^1].T - _poses[0].T;
    public Pose First => _poses[0];
    public Pose Last => _poses[^1];
    public Pose this[int index] => _poses[index];

    /// <summary>The pose at time t (seconds from the first sample), linear between samples, heading the short way round.</summary>
    public Pose At(double t)
    {
        var poses = _poses;
        double time = poses[0].T + Math.Clamp(t, 0, Duration);
        int lo = 0, hi = poses.Length - 1;
        while (hi - lo > 1)
        {
            int mid = (lo + hi) / 2;
            if (poses[mid].T <= time) lo = mid; else hi = mid;
        }
        var a = poses[lo];
        var b = poses[hi];
        double span = b.T - a.T;
        double f = span > 0 ? Math.Clamp((time - a.T) / span, 0, 1) : 0;
        double Lerp(double x, double y) => x + (y - x) * f;
        double dh = ((b.HeadingDeg - a.HeadingDeg) % 360 + 540) % 360 - 180;
        double heading = ((a.HeadingDeg + dh * f) % 360 + 360) % 360;
        return new Pose(time, Lerp(a.Lat, b.Lat), Lerp(a.Lon, b.Lon), Lerp(a.AltM, b.AltM), heading, Lerp(a.PitchDeg, b.PitchDeg), Lerp(a.BankDeg, b.BankDeg), Lerp(a.FovDeg, b.FovDeg));
    }
}
