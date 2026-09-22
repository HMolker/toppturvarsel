#!/usr/bin/env python3
"""
Makes test/fixtures/lm-sample.tif: a small tiled GeoTIFF packed the way
Lantmäteriet's Markhöjdmodell COG files are (as read from a real file's
header, 2026-09-23): float32, one sample, DEFLATE (8), floating-point
predictor (3), little-endian, 512 x 512 tiles -- here 64 x 64 tiles, so the
file stays small -- plus one reduced-resolution overview directory. (libtiff does not know the
GDAL_NODATA tag 42113 without GDAL registering it, so the -9999 here is
found by value, as the reader does when the tag is missing.)

Written with the system's libtiff through ctypes, i.e. the same library GDAL
uses to write the real files, so the JS decoder in src/sources/lmcog.js is
tested against an independent encoder, not against itself.

  python3 test/fixtures/make-cog.py test/fixtures/lm-sample.tif

Heights: h(x, y) = 500 + 0.8*x - 0.3*y + 20*sin(x/9) (x, y in pixels from
the NW corner, y down); pixel (0, 0) is nodata -9999.
"""
import ctypes, ctypes.util, math, struct, sys

out = sys.argv[1] if len(sys.argv) > 1 else 'lm-sample.tif'
lib = ctypes.CDLL(ctypes.util.find_library('tiff') or 'libtiff.so.6')
lib.TIFFOpen.restype = ctypes.c_void_p
lib.TIFFOpen.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
lib.TIFFWriteEncodedTile.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_ssize_t]
lib.TIFFWriteDirectory.argtypes = [ctypes.c_void_p]
lib.TIFFClose.argtypes = [ctypes.c_void_p]
lib.TIFFSetField.restype = ctypes.c_int
lib.TIFFSetField.argtypes = None  # variadic

W, H, T = 200, 150, 64
NODATA = -9999.0

def h(x, y):
    return 500 + 0.8 * x - 0.3 * y + 20 * math.sin(x / 9)

def setf(tif, tag, *vals):
    args = [ctypes.c_void_p(tif), ctypes.c_uint32(tag)]
    for v in vals:
        args.append(v)
    if lib.TIFFSetField(*args) != 1:
        raise SystemExit(f'TIFFSetField {tag} failed')

def write_image(tif, w, h_, step, reduced):
    setf(tif, 254, ctypes.c_uint32(1 if reduced else 0))   # NewSubfileType
    setf(tif, 256, ctypes.c_uint32(w))
    setf(tif, 257, ctypes.c_uint32(h_))
    setf(tif, 258, ctypes.c_int(32))                        # BitsPerSample
    setf(tif, 259, ctypes.c_int(8))                         # Compression: Adobe DEFLATE
    setf(tif, 262, ctypes.c_int(1))                         # BlackIsZero
    setf(tif, 277, ctypes.c_int(1))                         # SamplesPerPixel
    setf(tif, 284, ctypes.c_int(1))                         # PlanarConfig contig
    setf(tif, 317, ctypes.c_int(3))                         # Predictor: floating point
    setf(tif, 322, ctypes.c_uint32(T))
    setf(tif, 323, ctypes.c_uint32(T))
    setf(tif, 339, ctypes.c_int(3))                         # SampleFormat IEEE float
    nx, ny = (w + T - 1) // T, (h_ + T - 1) // T
    for ty in range(ny):
        for tx in range(nx):
            buf = bytearray(T * T * 4)
            for j in range(T):
                for i in range(T):
                    x, y = tx * T + i, ty * T + j
                    if x < w and y < h_:
                        v = NODATA if (x == 0 and y == 0 and not reduced) else h(x * step + (step - 1) / 2, y * step + (step - 1) / 2)
                    else:
                        v = 0.0
                    struct.pack_into('<f', buf, (j * T + i) * 4, v)
            b = (ctypes.c_char * len(buf)).from_buffer(buf)
            if lib.TIFFWriteEncodedTile(tif, ty * nx + tx, b, len(buf)) < 0:
                raise SystemExit('write tile failed')
    lib.TIFFWriteDirectory(tif)

tif = lib.TIFFOpen(out.encode(), b'wl')   # little-endian, like the real files
write_image(tif, W, H, 1, False)
write_image(tif, W // 4, H // 4 + 1, 4, True)
lib.TIFFClose(tif)
print('wrote', out)
