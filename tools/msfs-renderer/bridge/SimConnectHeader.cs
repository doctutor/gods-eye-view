// Personal fork: what the bridge takes from the installed SDK's SimConnect.h
// instead of hard-coding it: the enum values (message IDs, the World
// referential, the camera mask, the locker and camera states, the exception
// names), and a check that the structs it marshals (SimConnectNative.cs)
// still have the header's members in the header's order. The camera API is
// beta and its struct has changed between SDK releases (README.md), so a
// live run refuses to start on a mismatch.
using System.Text.RegularExpressions;

namespace GevBridge;

public sealed class SimConnectHeader
{
    public string FilePath { get; }
    public bool PacksToOne { get; }
    private readonly string _text;

    /// <summary>The members (type, in order) the bridge marshals, by struct.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Expected = new Dictionary<string, string[]>
    {
        ["SIMCONNECT_DATA_XYZ"] = new[] { "double", "double", "double" },
        ["SIMCONNECT_DATA_PBH"] = new[] { "float", "float", "float" },
        ["SIMCONNECT_DATA_CAMERA"] = new[]
        {
            "SIMCONNECT_DATA_XYZ", "SIMCONNECT_POSITION_REFERENTIAL", "DWORD", "SIMCONNECT_DATA_XYZ",
            "SIMCONNECT_DATA_PBH", "SIMCONNECT_POSITION_REFERENTIAL", "DWORD", "double",
        },
        ["SIMCONNECT_RECV_CAMERA_STATUS"] = new[] { "DWORD", "BOOL" },
        ["SIMCONNECT_RECV_CAMERA_WORLD_LOCKER"] = new[] { "SIMCONNECT_CAMERA_WORLD_LOCKER_STATUS" },
    };

    public SimConnectHeader(string file)
    {
        FilePath = file;
        var raw = File.ReadAllText(file);
        PacksToOne = Regex.IsMatch(raw, @"#\s*pragma\s+pack\s*\(\s*push\s*,\s*1\s*\)");
        var text = Regex.Replace(raw, @"/\*.*?\*/", " ", RegexOptions.Singleline);
        text = Regex.Replace(text, @"//[^\n]*", " ");
        text = Regex.Replace(text, @"^[ \t]*#[^\n]*", " ", RegexOptions.Multiline);
        _text = text;
    }

    /// <summary>SimConnect.h under the SDK root given, or MSFS2024_SDK, or MSFS_SDK.</summary>
    public static string? Find(string? sdkRoot)
    {
        foreach (var root in new[] { sdkRoot, Environment.GetEnvironmentVariable("MSFS2024_SDK"), Environment.GetEnvironmentVariable("MSFS_SDK") })
        {
            if (string.IsNullOrWhiteSpace(root)) continue;
            var file = Path.Combine(root, "SimConnect SDK", "include", "SimConnect.h");
            if (File.Exists(file)) return file;
        }
        return null;
    }

    private static readonly Regex EnumPattern = new(@"\benum\s+(?<name>\w+)\s*(?::\s*\w+\s*)?\{(?<body>[^}]*)\}", RegexOptions.Compiled);

    /// <summary>An enum's members and values, counting as C does.</summary>
    public Dictionary<string, long> Enum(string name)
    {
        foreach (Match m in EnumPattern.Matches(_text))
            if (m.Groups["name"].Value == name) return Values(m.Groups["body"].Value);
        throw new InvalidDataException($"{FilePath} has no enum {name}");
    }

    /// <summary>The enum one of whose members ends with the suffix (for enums whose name the docs do not give).</summary>
    public Dictionary<string, long>? EnumWithMember(string suffix)
    {
        foreach (Match m in EnumPattern.Matches(_text))
        {
            var values = Values(m.Groups["body"].Value);
            if (values.Keys.Any(k => k.EndsWith(suffix, StringComparison.Ordinal))) return values;
        }
        return null;
    }

    private static Dictionary<string, long> Values(string body)
    {
        var values = new Dictionary<string, long>();
        long next = 0;
        foreach (var entry in body.Split(new[] { ',', ';' }, StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = entry.Split('=', 2, StringSplitOptions.TrimEntries);
            if (!Regex.IsMatch(parts[0], @"^\w+$")) continue;
            long value = parts.Length == 2 ? Evaluate(parts[1], values) : next;
            values[parts[0]] = value;
            next = value + 1;
        }
        return values;
    }

    private static long Evaluate(string expression, IReadOnlyDictionary<string, long> known)
    {
        long result = 0;
        foreach (var term in expression.Split('|'))
        {
            var t = term.Trim().Trim('(', ')').Trim();
            var shift = t.Split("<<", 2, StringSplitOptions.TrimEntries);
            result |= shift.Length == 2 ? Number(shift[0], known) << (int)Number(shift[1], known) : Number(t, known);
        }
        return result;
    }

    private static long Number(string token, IReadOnlyDictionary<string, long> known)
    {
        var t = token.Trim().Trim('(', ')').TrimEnd('u', 'U', 'l', 'L');
        if (t.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return Convert.ToInt64(t[2..], 16);
        if (long.TryParse(t, out var n)) return n;
        if (known.TryGetValue(t, out var k)) return k;
        throw new InvalidDataException($"SimConnect.h: cannot read the value {token.Trim()}");
    }

    /// <summary>A struct's members as (type, name), in order; null when the header has no such struct.</summary>
    public List<(string Type, string Name)>? Struct(string name)
    {
        var m = Regex.Match(_text, @"\b(?:SIMCONNECT_STRUCT|SIMCONNECT_REFSTRUCT|struct)\s+" + Regex.Escape(name) + @"\b[^{;]*\{(?<body>[^}]*)\}");
        if (!m.Success) return null;
        var members = new List<(string, string)>();
        foreach (var declaration in m.Groups["body"].Value.Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            var tokens = Regex.Split(declaration.Trim(), @"\s+");
            if (tokens.Length < 2) continue;
            members.Add((string.Join(' ', tokens[..^1]), tokens[^1].TrimStart('*')));
        }
        return members;
    }

    /// <summary>The differences between the header and SimConnectNative.cs (empty: they match), and notes.</summary>
    public (List<string> Problems, List<string> Notes) CheckLayout()
    {
        var problems = new List<string>();
        var notes = new List<string>();
        if (!PacksToOne) problems.Add("SimConnect.h does not say #pragma pack(push, 1): the bridge's structs assume 1-byte packing");
        foreach (var (name, types) in Expected)
        {
            var members = Struct(name);
            if (members is null)
            {
                problems.Add($"no struct {name} in SimConnect.h");
                continue;
            }
            var actual = members.Select(m => m.Type).ToArray();
            if (!actual.SequenceEqual(types))
                problems.Add($"{name}: the header has [{string.Join(", ", actual)}], the bridge marshals [{string.Join(", ", types)}]");
            else
                notes.Add($"{name}: {string.Join(", ", members.Select(m => $"{m.Type} {m.Name}"))}");
        }
        return (problems, notes);
    }
}

/// <summary>The values a live run needs, read from the header.</summary>
public sealed class SimConnectIds
{
    public required long RecvException { get; init; }
    public required long RecvOpen { get; init; }
    public required long RecvQuit { get; init; }
    public required long RecvCameraStatus { get; init; }
    public required long RecvCameraWorldLocker { get; init; }
    public required uint ReferentialWorld { get; init; }
    public required uint MaskAllRotation { get; init; }
    public required long LockerSuccess { get; init; }
    public required long LockerCancel { get; init; }
    public required long LockerFail { get; init; }
    /// <summary>Camera acquired states by suffix (NOT_ACQUIRED, ACQUIRED, ACQUIRED_BY_OTHER, USER_DISABLED), if the header names them.</summary>
    public required IReadOnlyDictionary<long, string> AcquiredStates { get; init; }
    public required IReadOnlyDictionary<long, string> Exceptions { get; init; }

    public static SimConnectIds From(SimConnectHeader header)
    {
        var recv = header.Enum("SIMCONNECT_RECV_ID");
        var referential = header.Enum("SIMCONNECT_POSITION_REFERENTIAL");
        var mask = header.Enum("SIMCONNECT_CAMERA_DATA_MASK");
        var locker = header.Enum("SIMCONNECT_CAMERA_WORLD_LOCKER_STATUS");
        var exceptions = header.Enum("SIMCONNECT_EXCEPTION");
        // The docs name the states (NOT_ACQUIRED, ACQUIRED, ...) but not their enum.
        var states = header.EnumWithMember("ACQUIRED_BY_OTHER") ?? new Dictionary<string, long>();
        long Get(Dictionary<string, long> values, string key) =>
            values.TryGetValue(key, out var v) ? v : throw new InvalidDataException($"SimConnect.h has no {key}");
        uint allRotation = mask.TryGetValue("SIMCONNECT_CAMERA_DATA_MASK_ALL_ROTATION", out var all)
            ? (uint)all
            : (uint)(Get(mask, "SIMCONNECT_CAMERA_DATA_MASK_POSITION") | Get(mask, "SIMCONNECT_CAMERA_DATA_MASK_ROTATION")
                | Get(mask, "SIMCONNECT_CAMERA_DATA_MASK_FOV") | Get(mask, "SIMCONNECT_CAMERA_DATA_MASK_REFERENTIAL"));
        return new SimConnectIds
        {
            RecvException = Get(recv, "SIMCONNECT_RECV_ID_EXCEPTION"),
            RecvOpen = Get(recv, "SIMCONNECT_RECV_ID_OPEN"),
            RecvQuit = Get(recv, "SIMCONNECT_RECV_ID_QUIT"),
            RecvCameraStatus = Get(recv, "SIMCONNECT_RECV_ID_CAMERA_STATUS"),
            RecvCameraWorldLocker = Get(recv, "SIMCONNECT_RECV_ID_CAMERA_WORLD_LOCKER"),
            ReferentialWorld = (uint)Get(referential, "SIMCONNECT_POSITION_REFERENTIAL_WORLD"),
            MaskAllRotation = allRotation,
            LockerSuccess = Get(locker, "SIMCONNECT_CAMERA_WORLD_LOCKER_STATUS_SUCCESS"),
            LockerCancel = Get(locker, "SIMCONNECT_CAMERA_WORLD_LOCKER_STATUS_CANCEL"),
            LockerFail = Get(locker, "SIMCONNECT_CAMERA_WORLD_LOCKER_STATUS_FAIL"),
            AcquiredStates = states.GroupBy(p => p.Value).ToDictionary(g => g.Key, g => g.First().Key),
            Exceptions = exceptions.GroupBy(p => p.Value).ToDictionary(g => g.Key, g => g.First().Key),
        };
    }
}
