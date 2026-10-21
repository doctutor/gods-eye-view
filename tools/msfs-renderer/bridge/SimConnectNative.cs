// Personal fork: the native SimConnect.dll calls and structs the bridge uses
// (MSFS 2024 SDK, SimConnect camera API, which the SDK marks beta). Taken
// from the SDK reference (docs.flightsimulator.com/msfs2024, Camera API);
// SimConnectHeader checks them against the installed SDK's SimConnect.h
// before a live run, since the camera struct's layout has changed between
// SDK releases. SimConnect.h packs its structs to 1 byte.
using System.Runtime.InteropServices;

namespace GevBridge;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public struct SimConnectXyz
{
    public double X;
    public double Y;
    public double Z;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public struct SimConnectPbh
{
    public float Pitch;
    public float Bank;
    public float Heading;
}

/// <summary>SIMCONNECT_DATA_CAMERA, member for member (SimConnectHeader.CameraMembers).</summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public struct SimConnectCamera
{
    public SimConnectXyz Position;
    public uint PositionReferential;
    public uint PositionReferentialObjectId;
    public SimConnectXyz TargetedPos;
    public SimConnectPbh Pbh;
    public uint RotationReferential;
    public uint RotationReferentialObjectId;
    public double Fov; // radians
}

internal static class SimConnectNative
{
    private const string Dll = "SimConnect.dll";

    [DllImport(Dll, ExactSpelling = true)]
    public static extern int SimConnect_Open(out IntPtr phSimConnect, [MarshalAs(UnmanagedType.LPStr)] string szName, IntPtr hWnd, uint userEventWin32, IntPtr hEventHandle, uint configIndex);

    [DllImport(Dll, ExactSpelling = true)]
    public static extern int SimConnect_Close(IntPtr hSimConnect);

    [DllImport(Dll, ExactSpelling = true)]
    public static extern int SimConnect_GetNextDispatch(IntPtr hSimConnect, out IntPtr ppData, out uint pcbData);

    [DllImport(Dll, ExactSpelling = true)]
    public static extern int SimConnect_CameraAcquire(IntPtr hSimConnect, [MarshalAs(UnmanagedType.LPStr)] string clientId);

    [DllImport(Dll, ExactSpelling = true)]
    public static extern int SimConnect_CameraRelease(IntPtr hSimConnect, [MarshalAs(UnmanagedType.LPStr)] string cameraDefName);

    /// <summary>The struct by value, as SimConnect_CameraSet's C signature takes it.</summary>
    [DllImport(Dll, ExactSpelling = true)]
    public static extern int SimConnect_CameraSet(IntPtr hSimConnect, SimConnectCamera cameraData, uint dataMask);

    [DllImport(Dll, ExactSpelling = true)]
    public static extern int SimConnect_RequestCameraWorldLocker(IntPtr hSimConnect, SimConnectXyz lockerPosition, uint referential, uint objectId);

    [DllImport(Dll, ExactSpelling = true)]
    public static extern int SimConnect_DeleteCameraWorldLocker(IntPtr hSimConnect);

    [DllImport(Dll, ExactSpelling = true)]
    public static extern int SimConnect_SubscribeToCameraStatusUpdate(IntPtr hSimConnect);

    [DllImport(Dll, ExactSpelling = true)]
    public static extern int SimConnect_SubscribeToCameraWorldLockerStatusUpdate(IntPtr hSimConnect);
}

/// <summary>Windows' timer resolution, for frame pacing at 1 ms rather than 15.6.</summary>
internal static class WinMm
{
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint period);
    [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint period);
}
