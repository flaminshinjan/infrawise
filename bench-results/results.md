| Metric | 1 stream | 3 streams | Test environment |
|---|---:|---:|---|
| Delivered FPS (motion) | 33.3 | 27 | Apple M5 Pro, macOS 26.6.1 |
| Encode-out->client p50* | 0 ms | 0 ms | 3x Android 14 (API 34) arm64 AVD, 720x1280@320dpi, swiftshader, headless |
| Encode-out->client p95* | 2 ms | 1 ms | same |
| Tap->visible-change p50 | 97 ms | 117 ms | 30/15 samples |
| Tap->visible-change p95 | 132 ms | 161 ms | same |
| Input RTT p50 (ADB apply) | 296 ms | 302 ms | same |
| Server CPU (median) | 1.4% | 2.7% | server process only |
| Server RSS (median) | 86 MB | 100 MB | same |
| Allocation time | 11 ms | — | request -> reservation |

\* frame timestamps are applied when ffmpeg emits the JPEG, so this column
measures server-egress to client-receive on the same host; the full
capture-to-glass cost is captured by the tap-to-visible-change rows.
