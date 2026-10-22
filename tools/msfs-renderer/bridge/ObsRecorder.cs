// Personal fork: OBS Studio's built-in WebSocket server (obs-websocket v5,
// OBS 28 and later): connect, identify (with the password, if the server
// asks: base64(sha256(base64(sha256(password + salt)) + challenge))), and
// the requests the bridge makes: StartRecord / StopRecord around the
// playback, SaveSourceScreenshot for stills, and the settings and stats it
// reports. The password comes from OBS_WEBSOCKET_PASSWORD or the file
// airgpu-setup.ps1 writes (--obs-password-file), never the command line.
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace GevBridge;

/// <summary>The messages the bridge sends, built without a connection (so they can be tested).</summary>
public static class ObsRequests
{
    /// <summary>A request (op 6) with its type, id and optional requestData.</summary>
    public static JsonObject Request(string requestType, string requestId, JsonObject? data = null)
    {
        var d = new JsonObject { ["requestType"] = requestType, ["requestId"] = requestId };
        if (data is not null) d["requestData"] = data;
        return new JsonObject { ["op"] = 6, ["d"] = d };
    }

    /// <summary>
    /// SaveSourceScreenshot's requestData: the source (a scene renders at the
    /// canvas's size) as a PNG at an absolute path. Width and height are
    /// left out unless given, so the image keeps the source's own size.
    /// </summary>
    public static JsonObject SaveSourceScreenshot(string sourceName, string filePath, int? width = null, int? height = null)
    {
        if (!Path.IsPathFullyQualified(filePath)) throw new ArgumentException($"OBS needs an absolute path: {filePath}");
        var data = new JsonObject
        {
            ["sourceName"] = sourceName,
            ["imageFormat"] = "png",
            ["imageFilePath"] = filePath,
        };
        if (width is int w) data["imageWidth"] = w;
        if (height is int h) data["imageHeight"] = h;
        return data;
    }

    /// <summary>GetProfileParameter's requestData.</summary>
    public static JsonObject ProfileParameter(string category, string name) =>
        new() { ["parameterCategory"] = category, ["parameterName"] = name };

    /// <summary>The program scene's name from GetCurrentProgramScene (sceneName since 5.5, currentProgramSceneName before).</summary>
    public static string? ProgramSceneName(JsonNode? data) =>
        data?["sceneName"]?.GetValue<string>() ?? data?["currentProgramSceneName"]?.GetValue<string>();
}

public sealed class ObsRecorder : IAsyncDisposable
{
    private readonly ClientWebSocket _socket = new();
    private int _next;

    public static async Task<ObsRecorder> ConnectAsync(Uri url, string? password, CancellationToken ct)
    {
        var obs = new ObsRecorder();
        try
        {
            await obs._socket.ConnectAsync(url, ct);
            var hello = await obs.ReceiveAsync(ct);
            if (hello["op"]?.GetValue<int>() != 0) throw new InvalidDataException($"OBS: expected Hello, got {hello.ToJsonString()}");
            var identify = new JsonObject { ["rpcVersion"] = 1, ["eventSubscriptions"] = 0 };
            var auth = hello["d"]?["authentication"];
            if (auth is not null)
            {
                if (string.IsNullOrEmpty(password))
                    throw new InvalidOperationException("OBS asks for a password: run airgpu-setup.ps1 (it writes C:\\gev\\obs-websocket.txt), pass --obs-password-file, or set OBS_WEBSOCKET_PASSWORD");
                identify["authentication"] = Authentication(password, auth["salt"]!.GetValue<string>(), auth["challenge"]!.GetValue<string>());
            }
            await obs.SendAsync(new JsonObject { ["op"] = 1, ["d"] = identify }, ct);
            var identified = await obs.ReceiveAsync(ct);
            if (identified["op"]?.GetValue<int>() != 2) throw new InvalidDataException($"OBS: not identified ({identified.ToJsonString()})");
            return obs;
        }
        catch
        {
            await obs.DisposeAsync();
            throw;
        }
    }

    /// <summary>obs-websocket v5's authentication string.</summary>
    public static string Authentication(string password, string salt, string challenge)
    {
        var secret = Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(password + salt)));
        return Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(secret + challenge)));
    }

    /// <summary>A request and its response's responseData; throws when OBS says it failed.</summary>
    public async Task<JsonNode?> RequestAsync(string requestType, CancellationToken ct, JsonObject? data = null)
    {
        var id = $"gev-{Interlocked.Increment(ref _next)}";
        await SendAsync(ObsRequests.Request(requestType, id, data), ct);
        while (true)
        {
            var message = await ReceiveAsync(ct);
            if (message["op"]?.GetValue<int>() != 7) continue; // an event
            var d = message["d"];
            if (d?["requestId"]?.GetValue<string>() != id) continue;
            var status = d["requestStatus"];
            if (status?["result"]?.GetValue<bool>() != true)
                throw new InvalidOperationException($"OBS {requestType}: {status?["code"]} {status?["comment"]}");
            return d["responseData"];
        }
    }

    private Task SendAsync(JsonNode message, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        return _socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct);
    }

    private async Task<JsonNode> ReceiveAsync(CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        using var received = new MemoryStream();
        while (true)
        {
            var result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
            if (result.MessageType == WebSocketMessageType.Close) throw new IOException("OBS closed the connection");
            received.Write(buffer, 0, result.Count);
            if (result.EndOfMessage) break;
        }
        return JsonNode.Parse(received.ToArray()) ?? throw new InvalidDataException("OBS: an empty message");
    }

    public async ValueTask DisposeAsync()
    {
        if (_socket.State == WebSocketState.Open)
        {
            try { await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None); }
            catch (WebSocketException) { }
        }
        _socket.Dispose();
    }
}
