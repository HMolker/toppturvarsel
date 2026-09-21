#!/usr/bin/env python3
"""
Original soundtrack for the Fjällskred advert, synthesised from scratch: no
samples, no borrowed melodies. It is written in the après-ski idiom (four on
the floor, oom-pah bass, claps on two and four, an accordion-like lead, brass
stabs and the obligatory key change for the last chorus) but the hook and the
arrangement are its own.

    python3 demo/advert/music.py out.wav timeline.json

124 bpm. Follows the recorder's scene timeline:
  title / monday / editor   D major, light: pluck arpeggio and pad, then a soft kick
  plan / tuesday            the groove arrives: oom-pah bass, claps, the hook softly
  storm                     B minor, half time, wind, low drone; a drum fill out of it
  resort                    the après-ski party: full band, accordion hook, brass
  thursday                  key change to E major, bells like powder in the sun
  end                       last line of the hook, big E major chord, ring out
"""
import json
import sys
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve
from scipy.io import wavfile

OUT = sys.argv[1]
TL = json.load(open(sys.argv[2]))
SR = 44100
DUR = TL["total"] + 1.5
N = int(DUR * SR)
rng = np.random.default_rng(11)

BPM = 124
BEAT = 60 / BPM
BAR = 4 * BEAT
E8 = BEAT / 2

# ---------------------------------------------------------------- sections, snapped to bars
scene_start = {}
for s in TL["scenes"]:
    scene_start.setdefault(s["scene"], s["start"])


def bar_of(t):
    return int(round(t / BAR))


B_EDITOR = bar_of(scene_start["editor"])
B_PLAN = bar_of(scene_start["plan"])
B_TUE = bar_of(scene_start["tuesday"])
B_STORM = bar_of(scene_start["storm"])
B_RESORT = bar_of(scene_start["resort"])
B_THU = bar_of(scene_start["thursday"])
B_END = bar_of(scene_start["end"])
NBARS = int(DUR / BAR) + 1
T_TOAST = scene_start["thursday"] + 0.1 * 8 + 0.4  # the push notification fades in


def section(b):
    if b < B_EDITOR:
        return "intro"
    if b < B_PLAN:
        return "editor"
    if b < B_STORM:
        return "plan" if b < B_TUE else "tuesday"
    if b < B_RESORT:
        return "storm"
    if b < B_THU:
        return "party"
    if b < B_END:
        return "lift"
    return "end"


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


D = 62  # D4
# Chords as (root midi, quality) — four-bar loops.
PROG = {
    "light": [(D, "maj"), (D + 7, "maj"), (D + 9, "min"), (D + 5, "maj")],      # D A Bm G
    "storm": [(D + 9, "min"), (D + 5, "maj"), (D + 2, "min"), (D + 4, "maj")],  # Bm G Em F#
    "party": [(D, "maj"), (D + 5, "maj"), (D + 7, "maj"), (D, "maj")],          # D G A D
    "party2": [(D + 9, "min"), (D + 5, "maj"), (D + 7, "maj"), (D, "maj")],     # Bm G A D
}
LIFT = 2  # key change: up a whole tone, D -> E


def chord_for(b):
    sec = section(b)
    if sec == "storm":
        return PROG["storm"][(b - B_STORM) % 4], 0
    if sec in ("party", "lift", "end"):
        start = B_RESORT if sec == "party" else B_THU
        k = (b - start) // 4
        prog = PROG["party"] if k % 2 == 0 else PROG["party2"]
        shift = LIFT if sec in ("lift", "end") else 0
        if sec == "end":
            return (D + LIFT, "maj"), 0
        return prog[(b - start) % 4], shift
    if sec in ("plan", "tuesday"):
        k = (b - B_PLAN) // 4
        prog = PROG["party"] if k % 2 else PROG["light"]
        return prog[(b - B_PLAN) % 4], 0
    return PROG["light"][b % 4], 0


def triad(root, q):
    return [root, root + (4 if q == "maj" else 3), root + 7]


# ---------------------------------------------------------------- instruments
def adsr(n, a=0.01, d=0.08, s=0.7, r=0.08):
    t = np.arange(n) / SR
    dur = n / SR
    env = np.where(t < a, t / a, np.where(t < a + d, 1 - (1 - s) * (t - a) / d, s))
    rel = np.clip((dur - t) / r, 0, 1)
    return env * rel


def saw(f, n, harmonics=14, phase=0.0):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for h in range(1, harmonics + 1):
        if f * h > 9000:
            break
        out += np.sin(2 * np.pi * f * h * t + phase * h) / h
    return out


def accordion(f, n):
    """Two reeds a few cents apart plus an octave reed, with bellows tremolo."""
    t = np.arange(n) / SR
    w = saw(f * 2 ** (-4 / 1200), n, 10) + saw(f * 2 ** (5 / 1200), n, 10) + 0.45 * saw(2 * f, n, 6)
    trem = 1 - 0.22 * (0.5 + 0.5 * np.sin(2 * np.pi * 6.2 * t))
    return w * trem * adsr(n, 0.018, 0.1, 0.85, 0.06)


def pluck(f, n):
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t) + 0.1 * np.sin(6 * np.pi * f * t)) * np.exp(-t * 4.5) * np.clip(t / 0.004, 0, 1)


def brass(f, n):
    t = np.arange(n) / SR
    bright = np.exp(-t * 9)
    w = saw(f, n, 16) * (0.5 + 0.5 * bright) + 0.5 * saw(f * 1.003, n, 16)
    return w * adsr(n, 0.02, 0.1, 0.6, 0.05)


def bell(f, n):
    t = np.arange(n) / SR
    return sum(a * np.sin(2 * np.pi * f * r * t) * np.exp(-t * d) for r, a, d in ((1, 1, 2.2), (2.76, 0.35, 4), (5.4, 0.15, 7)))


def kick(n):
    t = np.arange(n) / SR
    f = 45 + 80 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7) * 1.1


def noise_hit(n, lo, hi, decay):
    t = np.arange(n) / SR
    x = sosfilt(butter(2, [lo, hi], btype="band", fs=SR, output="sos"), rng.standard_normal(n))
    return x * np.exp(-t * decay)


def clap(n):
    x = np.zeros(n)
    for k, off in enumerate((0, 0.011, 0.022)):
        i0 = int(off * SR)
        x[i0:] += noise_hit(n - i0, 900, 3500, 22 if k == 2 else 60)[: n - i0] * (0.6 if k < 2 else 1)
    return x


def tom(f, n):
    t = np.arange(n) / SR
    ff = f * (1 + 0.5 * np.exp(-t * 20))
    return np.sin(2 * np.pi * np.cumsum(ff) / SR) * np.exp(-t * 6)


# ---------------------------------------------------------------- tracks
L = np.zeros(N)
R = np.zeros(N)
drums = np.zeros(N)
send = np.zeros((N, 2))  # what goes to the reverb


def add(sig, t0, gain=1.0, pan=0.5, rev=0.25):
    i0 = int(t0 * SR)
    if i0 >= N or i0 < 0:
        return
    i1 = min(N, i0 + len(sig))
    s = sig[: i1 - i0] * gain
    L[i0:i1] += s * np.cos(pan * np.pi / 2)
    R[i0:i1] += s * np.sin(pan * np.pi / 2)
    send[i0:i1, 0] += s * rev * np.cos(pan * np.pi / 2)
    send[i0:i1, 1] += s * rev * np.sin(pan * np.pi / 2)


def add_drum(sig, t0, gain=1.0):
    i0 = int(t0 * SR)
    if i0 >= N:
        return
    i1 = min(N, i0 + len(sig))
    drums[i0:i1] += sig[: i1 - i0] * gain


# The hook: (start eighth, length in eighths, semitones above the key's tonic).
# Four bars over I–IV–V–I; the second time over vi–IV–V–I it starts higher.
HOOK_A = [
    (0, 2, 7), (2, 1, 7), (3, 1, 9), (4, 2, 7), (6, 2, 4),
    (8, 2, 5), (10, 1, 5), (11, 1, 4), (12, 2, 2), (14, 2, 5),
    (16, 2, 2), (18, 1, 4), (19, 1, 5), (20, 3, 7), (23, 1, 5),
    (24, 2, 4), (26, 2, 2), (28, 4, 0),
]
HOOK_B = [
    (0, 2, 9), (2, 1, 9), (3, 1, 11), (4, 2, 12), (6, 2, 9),
    (8, 2, 7), (10, 1, 7), (11, 1, 9), (12, 2, 7), (14, 2, 5),
    (16, 1, 4), (17, 1, 5), (18, 2, 7), (20, 2, 11), (22, 2, 9),
    (24, 3, 7), (27, 1, 4), (28, 4, 0),
]

for b in range(NBARS):
    t0 = b * BAR
    if t0 >= DUR - 0.5:
        break
    sec = section(b)
    (root, q), shift = chord_for(b)
    root += shift
    notes = triad(root, q)
    key = D + (LIFT if sec == "end" else shift)

    # --- pad (everywhere but the party, where the accordion carries it)
    if sec in ("intro", "editor", "plan", "tuesday", "storm", "lift", "end"):
        n = int((BAR + 0.3) * SR)
        g = {"intro": 0.05, "editor": 0.05, "plan": 0.04, "tuesday": 0.045, "storm": 0.07, "lift": 0.035, "end": 0.06}[sec]
        if sec == "end":
            n = int(min(DUR - t0, 7) * SR)
        for i, m in enumerate(notes + [notes[0] + 12]):
            w = saw(hz(m - 12 if sec == "storm" else m), n, 6)
            w = sosfilt(butter(1, 1400 if sec != "storm" else 700, fs=SR, output="sos"), w)
            env = adsr(n, 0.35, 0.2, 0.9, 0.5 if sec != "end" else 4.0)
            add(w * env, t0, g, 0.3 + 0.4 * (i % 2), 0.6)

    # --- pluck arpeggio: the quiet opening, and under the plan
    if sec in ("intro", "editor", "plan", "tuesday"):
        pattern = [0, 1, 2, 3, 2, 1, 2, 3]
        arp = notes + [notes[0] + 12]
        for k in range(8):
            f = hz(arp[pattern[k]] + 12)
            g = 0.11 if sec in ("intro", "editor") else 0.07
            add(pluck(f, int(0.9 * SR)), t0 + k * E8, g, 0.25 + 0.5 * (k % 2), 0.35)

    # --- drums
    if sec == "editor":
        for k in range(4):
            add_drum(kick(int(0.4 * SR)), t0 + k * BEAT, 0.45)
            add_drum(noise_hit(int(0.05 * SR), 6000, 12000, 80), t0 + k * BEAT + E8, 0.12)
    if sec in ("plan", "tuesday", "party", "lift"):
        big = sec in ("party", "lift")
        for k in range(4):
            add_drum(kick(int(0.4 * SR)), t0 + k * BEAT, 0.75 if big else 0.55)
            add_drum(noise_hit(int(0.06 * SR), 6000, 12000, 70), t0 + k * BEAT + E8, 0.22 if big else 0.14)
            if k % 2 == 1:
                add_drum(clap(int(0.25 * SR)), t0 + k * BEAT, 0.5 if big else 0.3)
        if big:
            for k in range(8):
                add_drum(noise_hit(int(0.03 * SR), 8000, 15000, 140), t0 + k * E8, 0.06)
    if sec == "storm":
        add_drum(kick(int(0.6 * SR)), t0, 0.7)
        add_drum(tom(70, int(0.8 * SR)), t0 + 2 * BEAT, 0.35)
        # the fill that throws you into the party
        if b == B_RESORT - 1:
            for k, f in enumerate((180, 180, 150, 150, 120, 120, 95, 95)):
                add_drum(tom(f, int(0.4 * SR)), t0 + 2 * BEAT + k * (BEAT / 4), 0.55)
    if b == B_RESORT or b == B_THU:
        add_drum(noise_hit(int(2.5 * SR), 4000, 14000, 1.6), t0, 0.3)  # crash

    # --- bass: soft root notes, then oom-pah
    if sec in ("plan", "tuesday", "party", "lift"):
        oom = hz(root - 24)
        pah = hz(root - 24 + 7 - 12)
        n = int(BEAT * 0.9 * SR)
        g = 0.5 if sec in ("party", "lift") else 0.35
        for k, f in ((0, oom), (2, pah)):
            w = (np.sin(2 * np.pi * f * np.arange(n) / SR) + 0.35 * np.sin(4 * np.pi * f * np.arange(n) / SR)) * adsr(n, 0.005, 0.2, 0.6, 0.05)
            add(w, t0 + k * BEAT, g, 0.5, 0.05)
    if sec == "storm":
        n = int((BAR + 0.1) * SR)
        f = hz(root - 24)
        t = np.arange(n) / SR
        w = np.sin(2 * np.pi * f * t) * (0.8 + 0.2 * np.sin(2 * np.pi * 0.5 * t)) * adsr(n, 0.2, 0.2, 0.9, 0.2)
        add(w, t0, 0.35, 0.5, 0.1)

    # --- chord stabs on two and four (the "pah")
    if sec in ("party", "lift"):
        n = int(BEAT * 0.35 * SR)
        for k in (1, 3):
            for m in notes:
                add(accordion(hz(m), n), t0 + k * BEAT, 0.035, 0.65, 0.2)
    if sec == "tuesday":
        n = int(BEAT * 0.3 * SR)
        for k in (1, 3):
            for m in notes:
                add(accordion(hz(m), n), t0 + k * BEAT, 0.02, 0.65, 0.2)

    # --- the hook
    if sec in ("party", "lift", "tuesday", "plan"):
        start = {"party": B_RESORT, "lift": B_THU}.get(sec, B_PLAN)
        k4 = (b - start) // 4
        if sec in ("plan", "tuesday"):
            # There the loops alternate light (no hook) and I–IV–V–I (hook A).
            line = HOOK_A if k4 % 2 == 1 else []
        else:
            line = HOOK_A if k4 % 2 == 0 else HOOK_B
        bar_in = (b - start) % 4
        g = {"plan": 0.05, "tuesday": 0.065, "party": 0.11, "lift": 0.12}[sec]
        for (e, ln, st) in line:
            if e // 8 != bar_in:
                continue
            f = hz(key + 12 + st)
            n = int(ln * E8 * SR * 0.95)
            add(accordion(f, n), t0 + (e % 8) * E8, g, 0.42, 0.3)
            if sec == "lift":  # a third above, like a second voice joining in
                add(accordion(hz(key + 12 + st + (4 if st in (0, 5, 7) else 3)), n), t0 + (e % 8) * E8, g * 0.45, 0.6, 0.3)

    # --- brass: pushes into each four-bar line in the party
    if sec in ("party", "lift") and (b - (B_RESORT if sec == "party" else B_THU)) % 4 == 3:
        n = int(E8 * 0.9 * SR)
        for k in (5, 6):
            for m in triad(root + 12 - 12, q):
                add(brass(hz(m), n), t0 + k * E8, 0.04, 0.35, 0.25)
        n2 = int(BEAT * 1.2 * SR)
        (nr, nq), _ = chord_for(b + 1)
        for m in triad(nr + shift, nq):
            add(brass(hz(m), n2), t0 + 7 * E8, 0.045, 0.35, 0.3)

    # --- bells: powder glitter on Thursday
    if sec == "lift":
        scale = [0, 2, 4, 7, 9, 12, 14, 16]
        for k in range(8):
            if (k + b) % 3 == 0:
                continue
            f = hz(key + 24 + scale[(k * 3 + b) % len(scale)])
            add(bell(f, int(1.4 * SR)), t0 + k * E8 + E8 / 2, 0.022, 0.2 + 0.6 * ((k * 7) % 5) / 4, 0.6)

    # --- the ending: last line of the hook, then the chord rings
    if sec == "end" and b == B_END:
        for (e, ln, st) in HOOK_A[-6:]:
            f = hz(key + 12 + st)
            add(accordion(f, int(ln * E8 * SR * 0.95)), t0 + (e - 20) * E8, 0.08, 0.42, 0.35)
        n = int(min(DUR - t0 - 4 * E8, 6) * SR)
        for m in triad(key, "maj") + [key + 12, key - 12]:
            add(accordion(hz(m), n) * np.exp(-np.arange(n) / SR * 0.5), t0 + 12 * E8, 0.05, 0.5, 0.5)
            add(brass(hz(m), n) * np.exp(-np.arange(n) / SR * 0.8), t0 + 12 * E8, 0.025, 0.4, 0.5)
        add_drum(noise_hit(int(4 * SR), 4000, 14000, 1.0), t0 + 12 * E8, 0.3)
        add_drum(kick(int(0.6 * SR)), t0 + 12 * E8, 0.8)

# ---------------------------------------------------------------- the storm's wind, a riser, the phone
t_all = np.arange(N) / SR
wind = sosfilt(butter(2, [200, 1500], btype="band", fs=SR, output="sos"), rng.standard_normal(N))
gust = 0.55 + 0.45 * np.sin(2 * np.pi * t_all / 5.3) * np.sin(2 * np.pi * t_all / 2.3 + 1)
ts, te = B_STORM * BAR, B_RESORT * BAR
wl = np.interp(t_all, [0, ts - 1, ts + 2, te - 2, te + 0.5, DUR], [0, 0, 1, 1, 0, 0])
# a gentler breeze on Tuesday afternoon
tt0 = B_TUE * BAR
wl += np.interp(t_all, [0, tt0 + 4, ts - 1, ts, DUR], [0, 0, 0.35, 0.5, 0.5]) * (t_all < ts)
wind *= gust * wl * 0.05
L += wind
R += np.roll(wind, 1300)

riser_n = int(2 * BAR * SR)
rt = np.arange(riser_n) / SR
riser = rng.standard_normal(riser_n)
riser = sosfilt(butter(2, 2500, btype="high", fs=SR, output="sos"), riser) * (rt / rt[-1]) ** 2
for at in (B_RESORT * BAR - 2 * BAR, B_THU * BAR - 2 * BAR):
    add(riser, at, 0.05, 0.5, 0.3)

for off, m in ((0, 88), (0.16, 93)):  # the ntfy chime
    add(bell(hz(m), int(1.2 * SR)), T_TOAST + off, 0.07, 0.7, 0.3)

# ---------------------------------------------------------------- mix
# Sidechain-style pump: music ducks a little under each kick in the party.
duck = np.ones(N)
for b in range(B_RESORT, B_END):
    for k in range(4):
        i0 = int((b * BAR + k * BEAT) * SR)
        n = int(0.18 * SR)
        if i0 + n < N:
            duck[i0:i0 + n] = np.minimum(duck[i0:i0 + n], 0.72 + 0.28 * np.linspace(0, 1, n))
L *= duck
R *= duck

ir_len = int(2.4 * SR)
ir_t = np.arange(ir_len) / SR
wet = np.zeros((N, 2))
for c in range(2):
    ir = rng.standard_normal(ir_len) * np.exp(-ir_t * 3.0)
    ir = sosfilt(butter(1, 4000, fs=SR, output="sos"), ir)
    ir /= np.sqrt(np.sum(ir ** 2))
    wet[:, c] = fftconvolve(send[:, c], ir)[:N]

mix = np.stack([L + drums, R + drums], axis=1) + 0.55 * wet
mix = sosfilt(butter(2, 30, btype="high", fs=SR, output="sos"), mix, axis=0)
fade = np.interp(t_all, [0, 0.8, DUR - 2.5, DUR], [0, 1, 1, 0])
mix *= fade[:, None]
mix /= np.max(np.abs(mix)) + 1e-9
mix = np.tanh(mix * 1.4) / np.tanh(1.4) * 0.9
wavfile.write(OUT, SR, (mix * 32767).astype(np.int16))
print(f"wrote {OUT}: {DUR:.1f} s, sections at bars editor {B_EDITOR}, plan {B_PLAN}, storm {B_STORM}, party {B_RESORT}, lift {B_THU}, end {B_END}")
