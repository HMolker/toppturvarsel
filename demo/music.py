#!/usr/bin/env python3
"""
Original soundtrack for the Fjällskred walkthrough, synthesised from scratch
(no samples, no third-party music), timed to the video's scenes.

    python3 demo/music.py out.wav [duration_s]

72 bpm, A minor. Calm pads and a soft arpeggio for the quiet days; a bell at
each powder alert; a low pulse and wind noise through the storm; brighter
harmony for the ski-resort scene; resolves and fades over the end card.
"""
import sys
import numpy as np
from scipy.signal import fftconvolve, butter, sosfilt
from scipy.io import wavfile

OUT = sys.argv[1] if len(sys.argv) > 1 else "music.wav"
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 121.0
SR = 44100
N = int(DUR * SR)
t_all = np.arange(N) / SR
rng = np.random.default_rng(7)

BPM = 72
BEAT = 60 / BPM
BAR = 4 * BEAT

# Scene timeline (seconds), matching demo/record-full.mjs.
ALERTS = [27.0, 67.0]
STORM = (57.0, 79.0)
RESORTS = (79.0, 99.0)
END = 116.0


def hz(note):
    """'A3' -> Hz."""
    names = {"C": -9, "C#": -8, "D": -7, "Eb": -6, "E": -5, "F": -4, "F#": -3, "G": -2, "Ab": -1, "A": 0, "Bb": 1, "B": 2}
    n, o = note[:-1], int(note[-1])
    return 440.0 * 2 ** ((names[n] + 12 * (o - 4)) / 12)


# Chords per section (voicings for the pad; arp uses the same tones).
CALM = [["A2", "E3", "B3", "C4", "G4"], ["F2", "C3", "A3", "E4", "G4"], ["C3", "G3", "D4", "E4", "B4"], ["G2", "D3", "B3", "E4", "A4"]]
STORMY = [["D2", "A2", "F3", "C4", "E4"], ["Bb1", "F2", "D3", "A3", "C4"], ["G2", "D3", "Bb3", "F4", "A4"], ["A1", "E2", "C#3", "E3", "A3"]]
BRIGHT = [["F2", "C3", "A3", "E4", "C5"], ["C3", "G3", "E4", "G4", "D5"], ["G2", "D3", "B3", "D4", "A4"], ["A2", "E3", "C4", "E4", "B4"]]


def chord_at(t):
    if t >= END:
        return ["A2", "E3", "B3", "C4", "E4"]
    if STORM[0] <= t < STORM[1]:
        prog = STORMY
    elif RESORTS[0] <= t < RESORTS[1]:
        prog = BRIGHT
    else:
        prog = CALM
    return prog[int(t // (2 * BAR)) % 4]


def env_curve(points):
    """Piecewise-linear envelope from [(t, v), ...] over the whole track."""
    ts, vs = zip(*points)
    return np.interp(t_all, ts, vs)


# ---------------------------------------------------------------- pad
pad = np.zeros((N, 2))
seg = 2 * BAR
k = 0
while k * seg < DUR:
    s0 = k * seg
    ch = chord_at(s0 + 0.01)
    length = seg + 1.5  # overlap for smooth crossfades
    n0, n1 = int(s0 * SR), min(N, int((s0 + length) * SR))
    tt = np.arange(n1 - n0) / SR
    a = np.clip(tt / 1.6, 0, 1) * np.clip((length - tt) / 1.6, 0, 1)
    for i, note in enumerate(ch):
        f = hz(note)
        for side, det in ((0, -0.18), (1, 0.18)):  # slight stereo detune
            ff = f * 2 ** (det / 100 * (1 + i % 2))
            w = np.zeros_like(tt)
            for h, amp in ((1, 1.0), (2, 0.28), (3, 0.12), (4, 0.05)):
                w += amp * np.sin(2 * np.pi * ff * h * tt + rng.uniform(0, 6.28))
            pad[n0:n1, side] += w * a * (0.4 if i == 0 else 0.34)
    k += 1

pad_level = env_curve([(0, 0), (3.5, 0.9), (STORM[0], 0.9), (STORM[0] + 2, 1.0), (RESORTS[1], 1.0), (END, 0.85), (DUR - 0.3, 0.0), (DUR, 0)])
pad *= pad_level[:, None] * 0.11

# ---------------------------------------------------------------- arpeggio
arp = np.zeros((N, 2))
step = BEAT / 2
arp_level = env_curve([
    (0, 0), (4, 0), (8, 0.45), (26.5, 0.45), (27.5, 0.75), (33, 0.55), (52, 0.5), (57, 0.35),
    (STORM[1], 0.45), (RESORTS[0] + 1, 0.8), (RESORTS[1], 0.7), (106, 0.4), (END, 0.15), (END + 1.5, 0), (DUR, 0),
])
pluck_len = int(1.6 * SR)
pt = np.arange(pluck_len) / SR
pattern = [2, 3, 4, 3, 1, 3, 4, 2]
j = 0
t = 4.0
while t < END + 1:
    ch = chord_at(t)
    note = ch[pattern[j % len(pattern)]]
    f = hz(note) * (2 if RESORTS[0] <= t < RESORTS[1] and j % 4 == 2 else 1)
    lvl = arp_level[min(N - 1, int(t * SR))]
    if lvl > 0.01:
        tone = (np.sin(2 * np.pi * f * pt) + 0.25 * np.sin(2 * np.pi * 2 * f * pt) + 0.08 * np.sin(2 * np.pi * 3 * f * pt))
        tone *= np.exp(-pt * 3.2) * np.clip(pt / 0.006, 0, 1)
        n0 = int(t * SR)
        n1 = min(N, n0 + pluck_len)
        pan = 0.5 + 0.35 * np.sin(j * 0.9)
        arp[n0:n1, 0] += tone[: n1 - n0] * lvl * (1 - pan)
        arp[n0:n1, 1] += tone[: n1 - n0] * lvl * pan
    j += 1
    t += step
arp *= 0.1

# ---------------------------------------------------------------- storm: pulse and wind
bass = np.zeros(N)
blen = int(0.9 * SR)
bt = np.arange(blen) / SR
t = STORM[0]
while t < STORM[1] + 2:
    root = hz(chord_at(t)[0]) if hz(chord_at(t)[0]) < 90 else hz(chord_at(t)[0]) / 2
    fade = min(1, (t - STORM[0]) / 3, max(0, (STORM[1] + 2 - t) / 3))
    thump = np.sin(2 * np.pi * root * bt) * np.exp(-bt * 4.5) * np.clip(bt / 0.01, 0, 1)
    n0 = int(t * SR)
    n1 = min(N, n0 + blen)
    bass[n0:n1] += thump[: n1 - n0] * fade
    t += BEAT
bass *= 0.22

noise = rng.standard_normal(N)
sos = butter(2, [250, 1400], btype="band", fs=SR, output="sos")
wind = sosfilt(sos, noise)
gust = 0.55 + 0.45 * np.sin(2 * np.pi * t_all / 7.3) * np.sin(2 * np.pi * t_all / 3.1 + 1)
wind_level = env_curve([(0, 0), (STORM[0] - 1, 0), (STORM[0] + 4, 1), (STORM[1] - 3, 1), (STORM[1] + 2, 0), (DUR, 0)])
wind = wind * gust * wind_level * 0.035

# ---------------------------------------------------------------- alert bells
bells = np.zeros((N, 2))
blen2 = int(4 * SR)
bt2 = np.arange(blen2) / SR
for at in ALERTS:
    for off, note in ((0, "E5"), (0.42, "A5"), (0.84, "C6")):
        f = hz(note)
        # inharmonic partials make it read as a bell
        tone = sum(a * np.sin(2 * np.pi * f * r * bt2) * np.exp(-bt2 * d) for r, a, d in ((1, 1, 1.4), (2.76, 0.4, 2.6), (5.4, 0.18, 4.5)))
        n0 = int((at + 0.5 + off) * SR)
        n1 = min(N, n0 + blen2)
        bells[n0:n1, 0] += tone[: n1 - n0] * 0.6
        bells[n0:n1, 1] += tone[: n1 - n0] * 0.45
bells *= 0.06

# ---------------------------------------------------------------- mix, reverb, master
dry = pad + arp + bells
dry[:, 0] += bass + wind
dry[:, 1] += bass + np.roll(wind, 1103)

ir_len = int(3.2 * SR)
ir_t = np.arange(ir_len) / SR
wet = np.zeros_like(dry)
for c in range(2):
    ir = rng.standard_normal(ir_len) * np.exp(-ir_t * 2.1)
    ir = sosfilt(butter(1, 3500, fs=SR, output="sos"), ir)
    ir /= np.sqrt(np.sum(ir ** 2))
    wet[:, c] = fftconvolve(dry[:, c], ir)[:N]
mix = 0.72 * dry + 0.38 * wet

# gentle high-pass to keep the low end clean
mix = sosfilt(butter(2, 35, btype="high", fs=SR, output="sos"), mix, axis=0)

fade = env_curve([(0, 0), (1.5, 1), (DUR - 3.5, 1), (DUR, 0)])
mix *= fade[:, None]
mix /= np.max(np.abs(mix)) + 1e-9
mix = np.tanh(mix * 1.1) / np.tanh(1.1) * 0.89  # soft ceiling around -1 dBFS
wavfile.write(OUT, SR, (mix * 32767).astype(np.int16))
print(f"wrote {OUT}: {DUR:.1f} s")
