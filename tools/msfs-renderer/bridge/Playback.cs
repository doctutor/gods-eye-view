// Personal fork: the bridge's playback clock. Frames are due on a monotonic
// clock (Stopwatch) at the path's fps; each step sends the frame the clock
// is at, so a late step skips the frames it missed rather than slowing the
// path down. The clock stops while the camera cannot be set (the sim's
// menus or pause, or the camera taken by another client or the user), so
// the path resumes where it stopped.
using System.Diagnostics;

namespace GevBridge;

public sealed record PlaybackStats(long Frames, long Sent, long Skipped, double Seconds, double PausedSeconds);

public static class Playback
{
    /// <param name="send">The frame number and its pose.</param>
    /// <param name="poll">Called every step (SimConnect's messages).</param>
    /// <param name="ready">Whether the camera can be set now (null: always).</param>
    /// <param name="realTime">False: every frame in turn, as fast as possible (a dry run's --fast).</param>
    public static PlaybackStats Run(CameraPathFile path, Action<long, Pose> send, Action? poll, Func<bool>? ready, bool realTime, CancellationToken ct)
    {
        double fps = path.Fps!.Value;
        long frames = (long)Math.Floor(path.Duration * fps + 1e-6) + 1;
        var clock = Stopwatch.StartNew();
        var paused = new Stopwatch();
        long last = -1, sent = 0, skipped = 0;
        bool fineTimer = realTime && OperatingSystem.IsWindows();
        if (fineTimer) WinMm.timeBeginPeriod(1);
        try
        {
            while (!ct.IsCancellationRequested)
            {
                poll?.Invoke();
                if (ready is not null && !ready())
                {
                    if (clock.IsRunning) { clock.Stop(); paused.Start(); }
                    Thread.Sleep(20);
                    continue;
                }
                if (!clock.IsRunning) { clock.Start(); paused.Stop(); }
                long frame = realTime ? (long)Math.Floor(clock.Elapsed.TotalSeconds * fps) : last + 1;
                if (frame >= frames) frame = frames - 1;
                if (frame > last)
                {
                    skipped += frame - last - 1;
                    send(frame, path.At(frame / fps));
                    sent++;
                    last = frame;
                    if (last == frames - 1) break;
                }
                if (realTime)
                {
                    double wait = (last + 1) / fps - clock.Elapsed.TotalSeconds;
                    if (wait > 0.0015) Thread.Sleep(TimeSpan.FromSeconds(wait - 0.001));
                    else if (wait > 0) Thread.SpinWait(200);
                }
            }
        }
        finally
        {
            if (fineTimer) WinMm.timeEndPeriod(1);
        }
        return new PlaybackStats(frames, sent, skipped, clock.Elapsed.TotalSeconds, paused.Elapsed.TotalSeconds);
    }
}
