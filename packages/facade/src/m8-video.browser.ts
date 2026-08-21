import {
  Video,
  createHostedCanvasRoot,
  type FrameReport,
  type HostTransportMode,
  type PingoMediaEvent,
  type VideoHandle,
} from "@dopejs/pingo";
import { afterEach, describe, expect, it } from "vitest";

const VIDEO_SRC =
  "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAPVbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAggAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAv90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAggAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAIIAAAEAAABAAAAAAJ3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAAGgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACIm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAeJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAADSVAAAAAAAAABhzdHRzAAAAAAAAAAEAAAANAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAeGN0dHMAAAAAAAAADQAAAAEAAAQAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAANAAAAAQAAAEhzdHN6AAAAAAAAAAAAAAANAAACywAAAAwAAAAMAAAADAAAAAwAAAASAAAADgAAAAwAAAAMAAAAEgAAAA4AAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAQFAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDAAAAAIZnJlZQAAA3NtZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNpPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAFWWIhAA7//7jq/gU0a+hz3ekUTewQQAAAAhBmiRsQ3/+4AAAAAhBnkJ4hf/BgQAAAAgBnmF0Qr/EgAAAAAgBnmNqQr/EgQAAAA5BmmhJqEFomUwIZ//+4QAAAApBnoZFESwv/8GBAAAACAGepXRCv8SBAAAACAGep2pCv8SAAAAADkGarEmoQWyZTAhX//7AAAAACkGeykUVLC//wYEAAAAIAZ7pdEK/xIAAAAAIAZ7rakK/xIA=";

describe("M8 Video transport matrix", () => {
  const roots: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await root.close();
    document.body.replaceChildren();
  });

  it("loads, controls, and composites bounded frames across all transports", async () => {
    const paths: string[] = [];
    for (const preference of ["main-thread", "post-message", "sab"] as const) {
      const result = await exercise(preference);
      paths.push(result.path);
      expect(result.maximumInFlight).toBeLessThanOrEqual(1);
      expect(result.submittedFrames).toBeGreaterThan(0);
      expect(result.loaded.type).toBe("loadedmetadata");
      expect(result.loaded.duration).toBeGreaterThan(0);
    }
    expect(paths[0]).toBe("html-media");
    expect(["image-bitmap", "video-frame"]).toContain(paths[1]);
    expect(paths[2]).toBe(paths[1]);
  });

  async function exercise(preference: HostTransportMode): Promise<{
    path: string;
    maximumInFlight: number;
    submittedFrames: number;
    loaded: PingoMediaEvent;
  }> {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 48;
    document.body.append(canvas);
    const reports: FrameReport[] = [];
    const loaded: PingoMediaEvent[] = [];
    const ref = { current: null as VideoHandle | null };
    const root = await createHostedCanvasRoot(canvas, {
      onFrame: (report) => reports.push(report),
      transport: { preference, strict: true },
    });
    roots.push(root);
    root.render(
      Video({
        autoPlay: true,
        height: 48,
        loop: true,
        muted: true,
        onLoadedMetadata: (event) => loaded.push(event),
        ref,
        src: VIDEO_SRC,
        style: { objectFit: "contain" },
        width: 80,
      }),
    );
    await waitUntil(
      () => reports.some((report) => report.cause === "media") && loaded.length > 0,
      5_000,
    );
    ref.current?.pause();
    ref.current?.seek(0.1);
    ref.current?.play();
    const mediaReport = reports.find((report) => report.cause === "media");
    const metrics = root.mediaMetrics();
    const metadata = loaded[0];
    if (mediaReport?.mediaPath === undefined || metrics === undefined || metadata === undefined) {
      throw new Error(`${preference} omitted Video diagnostics`);
    }
    await root.close();
    roots.pop();
    return {
      path: mediaReport.mediaPath,
      maximumInFlight: metrics.maximumInFlight,
      submittedFrames: metrics.submittedFrames,
      loaded: metadata,
    };
  }
});

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for Video frame");
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
}
