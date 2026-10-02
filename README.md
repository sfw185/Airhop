# Airhop

Send files between devices with a screen and a camera. Airhop runs entirely in the browser: no network, no pairing, no install, nothing uploaded.

The sender shows the file as an animated stream of colour codes. The receiver points a camera at it and rebuilds the file. It's an air gap you can cross with a phone.

Inspired by [Decimen Optical Transfer](https://www.reddit.com/r/ClaudeAI/s/R74T5q1CWY), which streams animated QR codes with LT fountain codes at up to ~180 kb/s. Airhop keeps the fountain-code idea but replaces QR with a barcode format built for video.

## Why not QR, or another 2D barcode standard?

QR is a poor fit for a video link:

- **One bit per cell.** QR is black and white only.
- **No partial credit.** QR's error correction is interleaved across the whole symbol, so a reflection or a rolling-shutter seam (the camera reads the top of the sensor before the screen flips and the bottom after) usually costs the entire frame.
- **Small codes.** A version-40 QR carries at most 2,953 bytes and is very hard to decode from video, so streaming projects use roughly 1 KB per frame.

Higher-density options exist:

| Format | Density | Notes |
| --- | --- | --- |
| [JAB Code](https://github.com/jabcode/jabcode) (ISO/IEC 23634:2022) | 8 colours, ~3× QR | Built for print and still images. The reference decoder is slow C, and there's no streaming or fountain layer. |
| Microsoft HCCB | 4–8 colour triangles | Discontinued. |
| [cimbar / libcimbar](https://github.com/sz3/libcimbar) | ~106 KB/s screen → phone | The best existing screen-to-camera system (colour icons, Reed–Solomon, wirehair fountain codes). Its web build is encoder-only; decoding needs the Android app. |

We control both ends, so there's no need to interoperate with a standard. Airhop uses its own frame format, designed for one job: **a browser on a phone decoding a laptop screen at video rate**.

## How it works

```
file ─▶ deflate (if it helps) ─▶ RaptorQ fountain code ─▶ packets
packets ─▶ one Reed–Solomon codeword per tile ─▶ tiles laid along a Hilbert curve ─▶ colour grid ─▶ screen
camera ─▶ finders ─▶ format ─▶ alignment lattice ─▶ local colour calibration ─▶ tiles ─▶ RS ─▶ packets ─▶ file
```

- **Fountain coding across frames.** [RaptorQ (RFC 6330)](https://www.rfc-editor.org/rfc/rfc6330) via the [`raptorq`](https://github.com/cberner/raptorq) WebAssembly build. The receiver can start any time and needs about *K* + 2 distinct packets in any order. Dropped and duplicated frames only cost time.
- **Tiles, not frames, are the unit of loss.** Each frame is cut into compact tiles, consecutive runs of cells along a generalised Hilbert curve. Each tile carries exactly one fountain packet inside its own Reed–Solomon codeword. A glare spot, a moiré band or a rolling-shutter seam only kills the tiles it touches; the other tiles in that frame still count.
- **Colour.** 2, 4 or 8 colours per cell (1–3 bits). The 4-colour palette is the odd-parity tetrahedron of the RGB cube (white, red, green, blue), so any two symbols differ in two channels. The 8-colour palette uses one bit per channel.
- **Local calibration.** Every alignment pattern is ringed with reference cells of each palette colour. Each data cell is classified against colours interpolated from its four nearest lattice nodes, which handles vignetting, white-balance errors, crosstalk and viewing-angle shifts. A decision-directed second pass then re-estimates the references from the data itself.
- **Geometry.** QR-style finders in the four corners give a first perspective estimate. A lattice of alignment patterns, searched outward from the corners, then gives a piecewise perspective transform that absorbs lens distortion. Large grids draw finders with 2-cell modules so they survive when cells shrink to about 3.5 camera pixels.
- **Live re-tuning.** The fountain symbol size is fixed across all frame formats. The sender can change density, colours or error-correction level mid-transfer, and the receiver keeps every packet it already has.

## Frame format (protocol v1)

All units are cells. `fm` (finder module) = 2 if `max(W, H) ≥ 176`, else 1.

| Element | Description |
| --- | --- |
| Grid | `W × H`, each a multiple of 8 in `[40, 512]`. A quiet zone of ≥ 3 white cells surrounds it. |
| Finders | 7×7 modules (dark ring / light ring / 3×3 dark centre) in each corner, plus a 1-module light separator. |
| Format strips | Next to each finder, rotated pinwheel-style: 2 rows × 16 modules = 32 bits. Bits are `W/8−1` (6), `H/8−1` (6), `bpc−1` (2), `ecc` (2), then a CRC-16 salted with the corner index, so a rotated read can't pass. One more row of 16·fm palette reference cells follows. Dark = 1. |
| Alignment lattice | Nodes run from finder centre to finder centre with spacing ≤ 32. Interior nodes are 5×5 patterns (dark / light / dark centre) ringed by 24 reference cells, cycling through the palette. A node that would collide with a reserved area is left virtual (interpolated). |
| Data | All remaining cells, in generalised-Hilbert order, cut into tiles of `⌈n·8 / bpc⌉` cells. Leftover cells are filler. |
| Cell bits | MSB-first bit stream, `bpc` bits per cell. The value is the palette index. |
| Tile codeword | `RS(n = 188 + p, k = 188)` over GF(256) (poly 0x11d, fcr 0). Parity `p` = 24 / 40 / 56 / 67 for ECC L / M / Q / H. The codeword is XORed with a mulberry32 keystream seeded `0x5eed0000 + tileIndex`. |
| Tile data (188 B) | `session u16` · `transferLength u32` · RaptorQ packet (`SBN u8` · `ESI u24` · 176-byte symbol) · `CRC-16/CCITT`. |
| Transfer object | `"AHOP"` · `version u8` · `flags u8` (bit 0 = deflate-raw) · `crc32(original) u32` · `size u32` · `nameLen u16` · name · `mimeLen u8` · mime · payload. |

Palettes (index → RGB):

- **2 colours:** 0 = black, 1 = white
- **4 colours:** 0 = white, 1 = red, 2 = green, 3 = blue
- **8 colours:** index bits `rgb`, so 0 = black, 1 = blue, 2 = green, 3 = cyan, 4 = red, 5 = magenta, 6 = yellow, 7 = white

## Performance

Payload per frame (after all headers, parity and patterns) at ECC M:

| Grid | 4 colours | 8 colours |
| --- | --- | --- |
| 128×72 | 1.4 KB | 2.2 KB |
| 192×104 | 3.1 KB | 4.8 KB |
| 256×144 | 6.0 KB | 9.1 KB |
| 320×176 | 9.6 KB | 14.4 KB |

Throughput is payload per frame × frames per second. A 256×144, 8-colour code at 10 fps is about 90 KB/s (0.7 Mbit/s). A 320×176 code at 10 fps is about 140 KB/s.

SIM_RESULTS_PLACEHOLDER

These numbers come from a synthetic camera (`src/sim/channel.ts`) that models perspective, barrel distortion, optical and motion blur, colour crosstalk and white-balance error, gamma, over-exposure, glare, vignetting, moiré banding, sensor noise and rolling-shutter seams. **They have not been validated on real phones yet.** Expect real-world results to be lower, and start with the defaults (Medium density, 4 colours, ECC M, 10 fps).

### Is native code faster?

The decoder isn't the bottleneck. A 1080p frame with a 320×176 grid decodes in about 50 ms of single-threaded JavaScript, and the receiver runs up to four decoder workers in parallel. The limits are optical: camera resolution (cells need about 4 camera pixels), the camera's frame rate (browsers usually get 30 fps) and focus and exposure control. A native app would help mostly because it can lock focus and exposure and capture at 60–240 fps, not because it computes faster. WebAssembly SIMD for the decoder is a later option.

## Use it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

Camera access requires a secure context (HTTPS or localhost). To use a phone as the receiver, serve over HTTPS. The included workflow publishes to GitHub Pages: in **Settings → Pages**, set **Source** to **GitHub Actions**, then push to `main`.

1. On the sending device, open **Send** and pick a file (or paste text). Go fullscreen.
2. On the receiving device, open **Receive**, start the camera, and fill the view with the sender's screen. Hold steady; propping the phone up helps.
3. When the bar fills, save or share the file. If the receiver reports a weak link, lower density or colours on the sender. The transfer continues without losing progress.

**Decode a recorded video** (on the receive page) runs the same decoder on a video file. It's useful for debugging real captures.

## Development

```sh
npm test           # unit + pipeline tests (RS codec, format, layout, simulated end-to-end)
npm run sim        # sweep grid sizes / palettes / channel severities through the synthetic camera
npm run e2e        # real Chromium: sender page → simulated camera, and fake webcam (Y4M) → receiver page
```

`npm run e2e` uses Playwright with a local Chromium (set `CHROME=/path/to/chrome`). Test B renders sender frames through the camera model into a Y4M file (4:2:0 chroma, rolling-shutter seams) and feeds it to `--use-file-for-fake-video-capture`, so the real receiver page, workers and camera pipeline decode it.

### Layout

```
src/core/      protocol: format, layout, Reed–Solomon, frame encoder/decoder, finder detection, RaptorQ wrapper, transfer
src/ui/        sender/receiver pages, canvas renderer, decode worker
src/sim/       synthetic camera channel, PNG and Y4M helpers (Node only)
scripts/       simulator sweep, E2E test, profiler
```

## Ideas

- A back-channel: the receiver shows a small QR with its missing-packet count or link quality, and the sender adapts automatically.
- Soft-decision decoding (LDPC) instead of byte-level Reed–Solomon, for more of the raw channel capacity.
- Per-device presets once there's real-world data.

## Third-party code

[`raptorq`](https://github.com/cberner/raptorq) (Apache-2.0) is bundled as WebAssembly. No licence has been chosen for Airhop itself yet.
