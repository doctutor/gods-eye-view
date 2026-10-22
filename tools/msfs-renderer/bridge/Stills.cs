// Personal fork: where along a camera path the bridge takes stills
// (--stills), and what each file is called. The path format is unchanged:
// the waypoints are its meta's from, via and to (scripts/msfs/cameraPath.mjs),
// each matched to the nearest sample; --every-s N takes one every N seconds
// of the path instead.
using System.Globalization;
using System.Text.Json;

namespace GevBridge;

/// <summary>One still: its time from the path's start, and what it is.</summary>
public readonly record struct StillAt(double T, string Label);

public static class Stills
{
    /// <summary>The waypoints named in a path's meta (from, via[], to), in order; empty without them.</summary>
    public static List<(double Lat, double Lon, string Label)> Waypoints(JsonElement? meta)
    {
        var points = new List<(double, double, string)>();
        if (meta is not JsonElement m || m.ValueKind != JsonValueKind.Object) return points;
        static bool Point(JsonElement e, out double lat, out double lon)
        {
            lat = lon = 0;
            return e.ValueKind == JsonValueKind.Object &&
                e.TryGetProperty("lat", out var a) && a.TryGetDouble(out lat) &&
                e.TryGetProperty("lon", out var o) && o.TryGetDouble(out lon);
        }
        if (m.TryGetProperty("from", out var from) && Point(from, out var fLat, out var fLon)) points.Add((fLat, fLon, "from"));
        if (m.TryGetProperty("via", out var via) && via.ValueKind == JsonValueKind.Array)
        {
            int n = 0;
            foreach (var v in via.EnumerateArray())
                if (Point(v, out var vLat, out var vLon)) points.Add((vLat, vLon, $"via{++n}"));
        }
        if (m.TryGetProperty("to", out var to) && Point(to, out var tLat, out var tLon)) points.Add((tLat, tLon, "to"));
        return points;
    }

    /// <summary>
    /// The stills' times: every <paramref name="everyS"/> seconds from 0 to
    /// the path's end (the end included), or, with everyS 0, the sample
    /// nearest each waypoint. Times are seconds from the first sample.
    /// </summary>
    public static List<StillAt> Plan(CameraPathFile path, double everyS)
    {
        var plan = new List<StillAt>();
        double duration = path.Duration;
        if (everyS > 0)
        {
            int count = (int)Math.Floor(duration / everyS + 1e-9);
            for (int i = 0; i <= count; i++) plan.Add(new StillAt(i * everyS, "step"));
            if (duration - count * everyS > 1e-6) plan.Add(new StillAt(duration, "end"));
            return plan;
        }
        var start = path.First.T;
        foreach (var (lat, lon, label) in Waypoints(path.Meta))
        {
            // The nearest sample on a local flat projection.
            double k = Math.Cos(lat * Math.PI / 180);
            int best = 0;
            double bestD = double.PositiveInfinity;
            for (int i = 0; i < path.Count; i++)
            {
                var p = path[i];
                double dy = p.Lat - lat, dx = (p.Lon - lon) * k;
                double d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; best = i; }
            }
            double t = path[best].T - start;
            if (plan.Count == 0 || Math.Abs(plan[^1].T - t) > 1e-6) plan.Add(new StillAt(t, label));
        }
        return plan;
    }

    /// <summary>
    /// A still's file: "&lt;path&gt;_&lt;run&gt;_&lt;nn&gt;_&lt;label&gt;_t&lt;seconds&gt;s_&lt;lat&gt;_&lt;lon&gt;.png"
    /// in <paramref name="dir"/>, e.g. baltimore_20261023-101500_01_from_t0000.000s_39.29040_-76.61220.png.
    /// </summary>
    public static string FileName(string dir, string pathFile, DateTime run, int index, StillAt still, Pose pose)
    {
        var stem = string.Concat(Path.GetFileNameWithoutExtension(pathFile).Select(c => char.IsLetterOrDigit(c) || c == '-' ? c : '_'));
        var label = string.Concat(still.Label.Select(c => char.IsLetterOrDigit(c) || c == '.' ? c : '_'));
        var name = string.Create(CultureInfo.InvariantCulture,
            $"{stem}_{run:yyyyMMdd-HHmmss}_{index:00}_{label}_t{still.T:0000.000}s_{pose.Lat:0.00000}_{pose.Lon:0.00000}.png");
        return Path.Combine(dir, name);
    }
}
