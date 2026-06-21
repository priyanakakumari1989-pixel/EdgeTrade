import zlib
import struct
import math

WIDTH = 1024
HEIGHT = 1024

BG = (14, 18, 26, 255)
GOLD = (201, 168, 76, 255)
WHITE = (245, 240, 232, 255)
DARK = (34, 40, 50, 255)
LIGHT = (70, 78, 90, 255)


def clamp(v):
    return 0 if v < 0 else 255 if v > 255 else int(v)


def blend(src, dst):
    sa = src[3] / 255.0
    da = dst[3] / 255.0
    oa = sa + da * (1 - sa)
    if oa == 0:
        return (0, 0, 0, 0)
    r = (src[0] * sa + dst[0] * da * (1 - sa)) / oa
    g = (src[1] * sa + dst[1] * da * (1 - sa)) / oa
    b = (src[2] * sa + dst[2] * da * (1 - sa)) / oa
    return (clamp(r), clamp(g), clamp(b), clamp(oa * 255))


def write_png(path, pixels):
    raw = b"".join(b"\x00" + row for row in pixels)
    def chunk(type_, data):
        return struct.pack(
            ">I", len(data)
        ) + type_ + data + struct.pack(">I", zlib.crc32(type_ + data) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def set_pixel(pixels, x, y, color):
    if x < 0 or x >= WIDTH or y < 0 or y >= HEIGHT:
        return
    idx = x * 4
    dst = tuple(pixels[y][idx:idx+4])
    pixels[y][idx:idx+4] = bytes(blend(color, dst))


def fill_background(pixels):
    row = bytes(BG)
    for y in range(HEIGHT):
        pixels[y] = bytearray(row)


def draw_circle(pixels, cx, cy, r, color, fill=True, thickness=0):
    r2 = r * r
    inner = (r - thickness) * (r - thickness)
    y0 = max(0, int(cy - r - 1))
    y1 = min(HEIGHT - 1, int(cy + r + 1))
    for y in range(y0, y1 + 1):
        dy = y - cy
        for x in range(max(0, int(cx - r - 1)), min(WIDTH - 1, int(cx + r + 1)) + 1):
            dx = x - cx
            d2 = dx * dx + dy * dy
            if fill:
                if d2 <= r2:
                    if thickness > 0:
                        if d2 >= inner:
                            set_pixel(pixels, x, y, color)
                    else:
                        set_pixel(pixels, x, y, color)
            else:
                if inner <= d2 <= r2:
                    set_pixel(pixels, x, y, color)


def draw_rect(pixels, x0, y0, x1, y1, color, radius=0, fill=True, thickness=0):
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    for y in range(max(0, int(y0 - 1)), min(HEIGHT - 1, int(y1 + 1)) + 1):
        for x in range(max(0, int(x0 - 1)), min(WIDTH - 1, int(x1 + 1)) + 1):
            inside = True
            if radius > 0:
                dx = 0
                dy = 0
                if x < x0 + radius and y < y0 + radius:
                    dx = x0 + radius - x
                    dy = y0 + radius - y
                elif x < x0 + radius and y > y1 - radius:
                    dx = x0 + radius - x
                    dy = y - (y1 - radius)
                elif x > x1 - radius and y < y0 + radius:
                    dx = x - (x1 - radius)
                    dy = y0 + radius - y
                elif x > x1 - radius and y > y1 - radius:
                    dx = x - (x1 - radius)
                    dy = y - (y1 - radius)
                if dx or dy:
                    if dx * dx + dy * dy > radius * radius:
                        inside = False
            if not inside:
                continue
            if fill:
                if thickness > 0:
                    if x < x0 + thickness or x > x1 - thickness or y < y0 + thickness or y > y1 - thickness:
                        set_pixel(pixels, x, y, color)
                else:
                    set_pixel(pixels, x, y, color)
            else:
                if thickness == 0:
                    if x == x0 or x == x1 or y == y0 or y == y1:
                        set_pixel(pixels, x, y, color)
                else:
                    raise ValueError("Unsupported rect stroke")


def draw_assistant(pixels):
    fill_background(pixels)
    draw_circle(pixels, WIDTH / 2, HEIGHT / 2, 470, GOLD, fill=False, thickness=28)
    draw_circle(pixels, WIDTH / 2, HEIGHT / 2, 430, BG, fill=True)
    # Head
    draw_circle(pixels, WIDTH / 2, HEIGHT / 2, 260, DARK, fill=True)
    draw_rect(pixels, WIDTH * 0.28, HEIGHT * 0.26, WIDTH * 0.72, HEIGHT * 0.36, GOLD, radius=32, fill=True)
    draw_rect(pixels, WIDTH * 0.22, HEIGHT * 0.34, WIDTH * 0.28, HEIGHT * 0.62, GOLD, radius=28, fill=True)
    draw_rect(pixels, WIDTH * 0.72, HEIGHT * 0.34, WIDTH * 0.78, HEIGHT * 0.62, GOLD, radius=28, fill=True)
    draw_rect(pixels, WIDTH * 0.22, HEIGHT * 0.46, WIDTH * 0.32, HEIGHT * 0.68, DARK, radius=24, fill=True)
    draw_rect(pixels, WIDTH * 0.68, HEIGHT * 0.46, WIDTH * 0.78, HEIGHT * 0.68, DARK, radius=24, fill=True)
    draw_rect(pixels, WIDTH * 0.32, HEIGHT * 0.56, WIDTH * 0.68, HEIGHT * 0.7, DARK, radius=32, fill=True)
    draw_circle(pixels, WIDTH * 0.4, HEIGHT * 0.44, 28, WHITE, fill=True)
    draw_circle(pixels, WIDTH * 0.6, HEIGHT * 0.44, 28, WHITE, fill=True)
    draw_rect(pixels, WIDTH * 0.47, HEIGHT * 0.58, WIDTH * 0.53, HEIGHT * 0.64, WHITE, radius=16, fill=True)


def draw_calculator(pixels):
    fill_background(pixels)
    draw_circle(pixels, WIDTH / 2, HEIGHT / 2, 470, GOLD, fill=False, thickness=28)
    draw_circle(pixels, WIDTH / 2, HEIGHT / 2, 430, BG, fill=True)
    draw_rect(pixels, WIDTH * 0.33, HEIGHT * 0.22, WIDTH * 0.67, HEIGHT * 0.78, DARK, radius=96, fill=True)
    draw_rect(pixels, WIDTH * 0.36, HEIGHT * 0.27, WIDTH * 0.64, HEIGHT * 0.35, LIGHT, radius=24, fill=True)
    btn_centers = [(-0.16, 0.04), (0, 0.04), (0.16, 0.04), (-0.16, 0.18), (0, 0.18), (0.16, 0.18), (-0.16, 0.32), (0, 0.32), (0.16, 0.32)]
    for dx, dy in btn_centers:
        draw_circle(pixels, WIDTH / 2 + dx * WIDTH, HEIGHT * 0.44 + dy * HEIGHT, 30, GOLD, fill=True)
    draw_circle(pixels, WIDTH / 2 + 0.16 * WIDTH, HEIGHT * 0.8, 30, WHITE, fill=True)
    draw_circle(pixels, WIDTH / 2 - 0.16 * WIDTH, HEIGHT * 0.8, 30, WHITE, fill=True)
    draw_rect(pixels, WIDTH * 0.42, HEIGHT * 0.35, WIDTH * 0.58, HEIGHT * 0.395, WHITE, radius=16, fill=True)


def gen(path, func):
    pixels = [bytearray(4 * WIDTH) for _ in range(HEIGHT)]
    func(pixels)
    write_png(path, pixels)

if __name__ == '__main__':
    gen('/workspaces/EdgeTrade/icons/assistant-icon.png', draw_assistant)
    gen('/workspaces/EdgeTrade/icons/calculator-icon.png', draw_calculator)
    print('Generated icons.')
