// Personal fork: one SimConnect connection holding MSFS 2024's add-on camera:
// open, subscribe to the camera's and the world locker's status, acquire
// the camera, place a world locker, set poses in the World referential with
// pitch/bank/heading (never the targeted mask: see README.md, the SU5 World
// look-at bug), and on dispose delete the locker, release the camera and
// close, whatever happened before.
using System.Runtime.InteropServices;

namespace GevBridge;

public sealed record CameraOptions(double PitchSign, double BankSign, double HeadingOffset, double AltFactor);

public sealed class SimSession : IDisposable
{
    private readonly SimConnectIds _ids;
    private readonly Action<string> _log;
    private readonly long _acquiredValue;
    private IntPtr _handle;
    private bool _open;
    private bool _acquireRequested;
    private bool _lockerRequested;

    public long AcquiredState { get; private set; } = -1;
    public bool GameControlled { get; private set; }
    public long LockerStatus { get; private set; } = -1;
    public bool Quit { get; private set; }
    public int CameraExceptions { get; private set; }

    /// <summary>The camera is the bridge's and not under the sim's control (menus, pause, the user).</summary>
    public bool Controllable => AcquiredState == _acquiredValue && !GameControlled;

    public SimSession(SimConnectIds ids, Action<string> log)
    {
        _ids = ids;
        _log = log;
        // ACQUIRED, as the header names it (the docs' order makes it 1 otherwise).
        _acquiredValue = ids.AcquiredStates
            .Where(p => p.Value.EndsWith("ACQUIRED", StringComparison.Ordinal) && !p.Value.Contains("NOT_") && !p.Value.Contains("OTHER"))
            .Select(p => p.Key)
            .DefaultIfEmpty(1)
            .First();
    }

    private static void Check(int hr, string call)
    {
        if (hr < 0) throw new InvalidOperationException($"{call} failed: HRESULT 0x{hr:X8}");
    }

    private string State(long state) => _ids.AcquiredStates.TryGetValue(state, out var name) ? name : $"state {state}";

    public void Open(string name, TimeSpan timeout, CancellationToken ct)
    {
        Check(SimConnectNative.SimConnect_Open(out _handle, name, IntPtr.Zero, 0, IntPtr.Zero, 0), "SimConnect_Open (is MSFS 2024 running?)");
        WaitFor(() => _open, timeout, "SimConnect's open message", ct);
        Check(SimConnectNative.SimConnect_SubscribeToCameraStatusUpdate(_handle), "SimConnect_SubscribeToCameraStatusUpdate");
        Check(SimConnectNative.SimConnect_SubscribeToCameraWorldLockerStatusUpdate(_handle), "SimConnect_SubscribeToCameraWorldLockerStatusUpdate");
        _log("connected to MSFS 2024");
    }

    public void Acquire(string clientId, TimeSpan timeout, CancellationToken ct)
    {
        Check(SimConnectNative.SimConnect_CameraAcquire(_handle, clientId), "SimConnect_CameraAcquire");
        _acquireRequested = true;
        WaitFor(() => Controllable, timeout, "the add-on camera (acquired and not under the sim's control)", ct);
        _log($"camera acquired ({State(AcquiredState)})");
    }

    /// <summary>A world locker at a pose (World referential: x latitude, y longitude, z altitude), and its loading finished.</summary>
    public void Lock(Pose at, CameraOptions options, TimeSpan timeout, CancellationToken ct)
    {
        var position = new SimConnectXyz { X = at.Lat, Y = at.Lon, Z = at.AltM * options.AltFactor };
        Check(SimConnectNative.SimConnect_RequestCameraWorldLocker(_handle, position, _ids.ReferentialWorld, 0), "SimConnect_RequestCameraWorldLocker");
        _lockerRequested = true;
        WaitFor(() => LockerStatus == _ids.LockerSuccess || LockerStatus == _ids.LockerFail || LockerStatus == _ids.LockerCancel,
            timeout, "the world locker's loading", ct);
        if (LockerStatus != _ids.LockerSuccess)
            throw new InvalidOperationException($"the world locker {(LockerStatus == _ids.LockerFail ? "failed" : "was cancelled (the sim may be low on memory)")}");
        _log("world locker loaded around the start");
    }

    public void Set(Pose pose, CameraOptions options)
    {
        var camera = new SimConnectCamera
        {
            Position = new SimConnectXyz { X = pose.Lat, Y = pose.Lon, Z = pose.AltM * options.AltFactor },
            PositionReferential = _ids.ReferentialWorld,
            PositionReferentialObjectId = 0,
            TargetedPos = default,
            Pbh = new SimConnectPbh
            {
                Pitch = (float)(options.PitchSign * pose.PitchDeg),
                Bank = (float)(options.BankSign * pose.BankDeg),
                Heading = (float)(((pose.HeadingDeg + options.HeadingOffset) % 360 + 360) % 360),
            },
            RotationReferential = _ids.ReferentialWorld,
            RotationReferentialObjectId = 0,
            Fov = pose.FovDeg * Math.PI / 180,
        };
        Check(SimConnectNative.SimConnect_CameraSet(_handle, camera, _ids.MaskAllRotation), "SimConnect_CameraSet");
    }

    /// <summary>Read every queued message: camera and locker status, exceptions, quit.</summary>
    public void Dispatch()
    {
        if (_handle == IntPtr.Zero) return;
        while (SimConnectNative.SimConnect_GetNextDispatch(_handle, out var data, out var size) >= 0 && data != IntPtr.Zero && size >= 12)
        {
            long id = (uint)Marshal.ReadInt32(data, 8);
            if (id == _ids.RecvOpen) _open = true;
            else if (id == _ids.RecvQuit) Quit = true;
            else if (id == _ids.RecvCameraStatus && size >= 20)
            {
                long state = (uint)Marshal.ReadInt32(data, 12);
                bool game = Marshal.ReadInt32(data, 16) != 0;
                if (state != AcquiredState || game != GameControlled)
                    _log($"camera: {State(state)}{(game ? ", under the sim's control" : "")}");
                AcquiredState = state;
                GameControlled = game;
            }
            else if (id == _ids.RecvCameraWorldLocker && size >= 16) LockerStatus = (uint)Marshal.ReadInt32(data, 12);
            else if (id == _ids.RecvException && size >= 24)
            {
                long code = (uint)Marshal.ReadInt32(data, 12);
                var name = _ids.Exceptions.TryGetValue(code, out var n) ? n : $"exception {code}";
                if (name.EndsWith("CAMERA_API", StringComparison.Ordinal)) CameraExceptions++;
                // CameraSet raises one a frame once the camera is lost: say it once in a while.
                if (CameraExceptions <= 3 || CameraExceptions % 300 == 0)
                    _log($"SimConnect: {name} (send {Marshal.ReadInt32(data, 16)}, parameter {Marshal.ReadInt32(data, 20)})");
            }
        }
    }

    private void WaitFor(Func<bool> condition, TimeSpan timeout, string what, CancellationToken ct)
    {
        var until = DateTime.UtcNow + timeout;
        while (!condition())
        {
            ct.ThrowIfCancellationRequested();
            Dispatch();
            if (Quit) throw new InvalidOperationException("MSFS 2024 quit");
            if (condition()) break;
            if (DateTime.UtcNow > until)
                throw new TimeoutException($"no {what} within {timeout.TotalSeconds:0} s{(AcquiredState >= 0 ? $" (camera: {State(AcquiredState)}{(GameControlled ? ", under the sim's control" : "")})" : "")}");
            Thread.Sleep(20);
        }
    }

    public void Dispose()
    {
        if (_handle == IntPtr.Zero) return;
        try
        {
            if (_lockerRequested) SimConnectNative.SimConnect_DeleteCameraWorldLocker(_handle);
            if (_acquireRequested) SimConnectNative.SimConnect_CameraRelease(_handle, "");
            Dispatch();
        }
        finally
        {
            SimConnectNative.SimConnect_Close(_handle);
            _handle = IntPtr.Zero;
            _log("camera and locker released, SimConnect closed");
        }
    }
}
