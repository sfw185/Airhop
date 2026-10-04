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
- **Blur equalisation.** Optical blur makes neighbouring cells bleed into each other, and that bleed is the real density limit. After a first classification pass, the decoder fits how much each cell picks up from its 4- and 8-neighbours (least squares over the whole frame), subtracts that bleed using the decided neighbour colours, and classifies again. In simulation it raises the blur an 8-colour 256×144 code survives at 720p from about σ = 1.6 px to about σ = 2.1 px.
- **Geometry.** QR-style finders in the four corners give a first perspective estimate. A lattice of alignment patterns, searched outward from the corners, then gives a piecewise perspective transform that absorbs lens distortion. Large grids draw finders with 2-cell modules so they survive when cells shrink to about 3.5 camera pixels.
- **A hidden corner is fine.** If glare or a finger hides one finder, or a false detection stands in for it, the decoder rebuilds that corner from the other three, reads the format from the remaining copies, and re-locates the corner from the alignment lattice.
- **Live re-tuning.** The fountain symbol size is fixed across all frame formats. The sender can change density, colours or error-correction level mid-transfer, and the receiver keeps every packet it already has.

## Frame format (protocol v1)

All units are cells. `fm` (finder module) = 2 if `max(W, H) ≥ 176`, else 1.

| Element | Description |
| --- | --- |
| Grid | `W × H`, each a multiple of 8 in `[40, 512]`. A quiet zone of ≥ 3 white cells surrounds it. |
| Finders | 7×7 modules (dark ring / light ring / 3×3 dark centre) in each corner, plus a 1-module light separator. |
| Format L | Wrapped around each finder in corner-local coordinates (`u` along the corner's first edge, `v` along its second; each corner is the previous one rotated 90°). Bits 0–15 sit at modules `u ∈ {8, 9}`, `v = 0…7`; bits 16–31 at `v ∈ {8, 9}`, `u = 0…7`. Bits are `W/8−1` (6), `H/8−1` (6), `bpc−1` (2), `ecc` (2), then a CRC-16 salted with the corner index, so a rotated read can't pass. Dark = 1. |
| Corner references | Palette cells cycling through the colours: the 2×2-module square where the L's arms meet, plus a 16×1-module strip at `u = 10…25`, `v = 0`. |
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

Payload per frame (after all headers, parity and patterns) at ECC M, and the share of tiles decoded per frame through the simulated camera. `px/cell` is how many camera pixels each cell spans when the code fills 88% of the image width. Each cell of the table averages 8 (720p) or 6 (1080p) random cameras per severity.

| Grid | Colours | Payload/frame | 720p camera (px/cell): mild / moderate / harsh | 1080p camera (px/cell): mild / moderate / harsh |
| --- | --- | --- | --- | --- |
| 128×72 | 4 | 1.4 KB | (8.4) 100% / 100% / 100% | (12.6) 100% / 100% / 100% |
| 128×72 | 8 | 2.2 KB | (8.4) 100% / 100% / 100% | (12.6) 100% / 100% / 100% |
| 192×104 | 4 | 3.1 KB | (5.7) 100% / 100% / 100% | (8.5) 100% / 100% / 100% |
| 192×104 | 8 | 4.6 KB | (5.7) 100% / 100% / 100% | (8.5) 100% / 100% / 100% |
| 256×144 | 4 | 6.0 KB | (4.3) 100% / 100% / 98% | (6.4) 100% / 100% / 98% |
| 256×144 | 8 | 9.1 KB | (4.3) 100% / 100% / 98% | (6.4) 100% / 100% / 99% |
| 320×176 | 4 | 9.5 KB | (3.5) 100% / 100% / 82% | (5.2) 100% / 100% / 79% |
| 320×176 | 8 | 14.3 KB | (3.5) 100% / 100% / 56% | (5.2) 100% / 100% / 83% |

Throughput is payload per frame × frames per second. A 256×144, 8-colour code at 10 fps is about 90 KB/s (0.7 Mbit/s); a 320×176 one is about 140 KB/s. Losing a few percent of tiles only costs the same few percent of speed, because every decoded tile is a useful fountain packet.

These numbers come from a synthetic camera (`src/sim/channel.ts`) that models perspective, barrel distortion, optical and motion blur, colour crosstalk and white-balance error, gamma, over-exposure, glare, vignetting, moiré banding, sensor noise and rolling-shutter seams. **They have not been validated on real phones yet.** Expect real-world results to be lower, and start with the defaults (Medium density, 4 colours, ECC M, 10 fps).

### Is native code faster?

The decoder isn't the bottleneck. A 1080p frame with a 320×176 grid decodes in roughly 50–100 ms of single-threaded JavaScript on a laptop core, and the receiver runs up to four decoder workers in parallel. The limits are optical: camera resolution (cells need about 4 camera pixels), the camera's frame rate (browsers usually get 30 fps) and focus and exposure control. A native app would help mostly because it can lock focus and exposure and capture at 60–240 fps, not because it computes faster. WebAssembly SIMD for the decoder is a later option.

## Use it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

Camera access requires a secure context (HTTPS or localhost). To use a phone as the receiver, serve over HTTPS. The included workflow publishes the default branch to GitHub Pages: in **Settings → Pages**, set **Source** to **GitHub Actions**, then re-run the workflow or push. Once a device has loaded the page, a service worker keeps it working offline.

1. On the sending device, open **Send** and pick a file (or paste text). Go fullscreen.
2. On the receiving device, open **Receive**, start the camera, and fill the view with the sender's screen. Hold steady; propping the phone up helps.
3. When the bar fills, save or share the file. If the receiver reports a weak link, lower density or colours on the sender. The transfer continues without losing progress.

### Install and offline

Airhop is an installable web app: Android/desktop Chrome offer **Install app** on the home page, and on iPhone use **Share → Add to Home Screen**. After one online visit it works with no network at all:

- The service worker (`src/sw.template.js`, filled in at build time by `vite.config.ts`) precaches every file of the build on install, and answers every navigation with the cached app, whatever the query or hash.
- A new deploy installs in the background and waits. The home page shows **Update ready: reload**, and an open page (for example, mid-transfer) is never switched underneath you.
- The app asks for persistent storage so the browser is less likely to evict the offline copy. On iPhone, add it to the Home Screen and open it once while online: Safari can clear data for sites that aren't installed after a few weeks unused.
- `npm run e2e` checks this: test C cuts the network after one visit, then reloads, sends and receives a file through the fake camera; test D checks the update flow.

Icons are generated by `scripts/icons.ts` (192/512 px, maskable 512 px, and the 180 px Apple touch icon).

**Decode a recorded video** (on the receive page) runs the same decoder on a video file. The **Diagnostics** panel shows per-stage timings, lock state, alignment hits, Reed–Solomon corrections and the fitted blur. Both are useful for debugging real captures.

## Development

```sh
npm test           # unit + pipeline tests (RS codec, format, layout, simulated end-to-end)
npm run sim        # sweep grid sizes / palettes / channel severities through the synthetic camera
npm run e2e        # real Chromium: sender page → simulated camera, fake webcam (Y4M) → receiver page, offline, updates
```

`npm run e2e` uses Playwright with a local Chromium (set `CHROME=/path/to/chrome`). Test B renders sender frames through the camera model into a Y4M file (4:2:0 chroma, rolling-shutter seams) and feeds it to `--use-file-for-fake-video-capture`, so the real receiver page, workers and camera pipeline decode it.

### Layout

```
src/core/      protocol: format, layout, Reed–Solomon, frame encoder/decoder, finder detection, RaptorQ wrapper, transfer
src/ui/        sender/receiver pages, canvas renderer, decode worker
src/sim/       synthetic camera channel, PNG and Y4M helpers (Node only)
scripts/       simulator sweep, E2E test, per-frame diagnostics, profiler, UI screenshots
```

## Ideas

- A back-channel: the receiver shows a small QR with its missing-packet count or link quality, and the sender adapts automatically.
- Soft-decision decoding (LDPC) instead of byte-level Reed–Solomon, for more of the raw channel capacity.
- Per-device presets once there's real-world data.

## Third-party code

[`raptorq`](https://github.com/cberner/raptorq) (Apache-2.0) is bundled as WebAssembly. No licence has been chosen for Airhop itself yet.
