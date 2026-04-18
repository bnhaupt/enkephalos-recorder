"""
Erzeugt pwa/icon-192.png und pwa/icon-512.png fuer die Claudia-PWA.

Design: minimalistische Frontansicht einer stilisierten Frau:
cremefarbener Rundrecht-Hintergrund, Kopf als Ellipse, Schultern als
gerundete Flaeche, darueber eine dezente Haarwelle, darunter der
Schriftzug "Claudia". Alles in Claude-Coral.

Ausfuehrung:
    python scripts/make-icons.py
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = Path(__file__).resolve().parent
PWA = HERE.parent / "pwa"

BG = (245, 240, 232)       # cremefarbenes Claude-Background
ACCENT = (204, 120, 92)    # Claude-Coral (#CC785C)
ACCENT_DEEP = (172, 95, 72)  # etwas dunkler fuer das Haar
INK = (51, 46, 40)         # warmes Dunkelbraun fuer Text

# Windows-Systemschriften; Georgia Italic wirkt passender zum warmen
# Claude-Branding als eine sachliche Sans.
FONT_CANDIDATES = [
    "C:/Windows/Fonts/georgiai.ttf",
    "C:/Windows/Fonts/georgia.ttf",
    "C:/Windows/Fonts/seguisli.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "arial.ttf",
]


def find_font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def draw_icon_typographic(size: int) -> Image.Image:
    """
    Variante A: reines typografisches Logo. Monogram-Kreis mit "C",
    darunter "Claudia". Minimalistisch, immer elegant.
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = int(size * 0.18)
    d.rounded_rectangle([(0, 0), (size, size)], radius=radius, fill=BG)

    cx = size / 2
    # Monogram-Kreis
    circ_cy = size * 0.40
    circ_r = size * 0.22
    d.ellipse(
        [
            (cx - circ_r, circ_cy - circ_r),
            (cx + circ_r, circ_cy + circ_r),
        ],
        fill=ACCENT,
    )
    # "C" im Kreis, cremefarben
    c_font = find_font(int(size * 0.32))
    bbox = d.textbbox((0, 0), "C", font=c_font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    d.text(
        (cx - tw / 2 - bbox[0], circ_cy - th / 2 - bbox[1]),
        "C",
        fill=BG,
        font=c_font,
    )

    # "Claudia" unterhalb
    label = "Claudia"
    font = find_font(int(size * 0.13))
    bbox = d.textbbox((0, 0), label, font=font)
    tw = bbox[2] - bbox[0]
    ty = int(size * 0.78)
    d.text(((size - tw) / 2 - bbox[0], ty - bbox[1]), label, fill=INK, font=font)

    return img


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Hintergrund: gerundetes Rechteck, fast vollflaechig
    radius = int(size * 0.18)
    d.rounded_rectangle([(0, 0), (size, size)], radius=radius, fill=BG)

    cx = size / 2

    # Layout-Anker (alle als Bruchteil von size)
    head_cy = size * 0.32
    head_rx = size * 0.14
    head_ry = size * 0.17

    # Reihenfolge (back-to-front):
    #   Haar (lang) -> Schultern -> Haar-Vordere-Straehnen -> Hals -> Kopf -> Pony

    # 1) Langes Haar: grosse Ellipse hinter allem, oben buendig mit
    #    dem Kopf (keine Haube drueber), seitlich deutlich breiter,
    #    reicht bis ueber die Schultern. Klarstes "Frau"-Signal.
    hair_top = head_cy - head_ry * 0.95
    hair_bottom = size * 0.72
    hair_half_w = head_rx * 2.0
    d.ellipse(
        [
            (cx - hair_half_w, hair_top),
            (cx + hair_half_w, hair_bottom),
        ],
        fill=ACCENT_DEEP,
    )

    # 2) Schultern: breiter ovaler Torso, etwas vor dem Haar.
    torso_top_y = head_cy + head_ry + size * 0.05
    torso_half_w = size * 0.33
    torso_bottom_extend = size * 0.70
    d.ellipse(
        [
            (cx - torso_half_w, torso_top_y),
            (cx + torso_half_w, torso_top_y + torso_bottom_extend),
        ],
        fill=ACCENT,
    )

    # 3) Vordere Haarstraehnen links und rechts auf den Schultern,
    #    damit das Haar "ueber die Schultern faellt". Zwei schmale
    #    Tropfenformen in ACCENT_DEEP.
    strand_w = head_rx * 0.55
    strand_top = head_cy + head_ry * 0.2
    strand_bottom = size * 0.70
    # links
    d.ellipse(
        [
            (cx - head_rx * 1.5, strand_top),
            (cx - head_rx * 1.5 + strand_w, strand_bottom),
        ],
        fill=ACCENT_DEEP,
    )
    # rechts
    d.ellipse(
        [
            (cx + head_rx * 1.5 - strand_w, strand_top),
            (cx + head_rx * 1.5, strand_bottom),
        ],
        fill=ACCENT_DEEP,
    )

    # 4) Hals: schmales abgerundetes Rechteck
    neck_half_w = size * 0.05
    d.rounded_rectangle(
        [
            (cx - neck_half_w, head_cy + head_ry * 0.55),
            (cx + neck_half_w, torso_top_y + size * 0.015),
        ],
        radius=int(neck_half_w),
        fill=ACCENT,
    )

    # 5) Kopf: Ellipse in ACCENT, ueber dem Haar
    d.ellipse(
        [
            (cx - head_rx, head_cy - head_ry),
            (cx + head_rx, head_cy + head_ry),
        ],
        fill=ACCENT,
    )

    # 6) Pony: schmaler Bogen nur im obersten Kopfdrittel, asymmetrisch
    #    Seitenscheitel-artig. Stirn bleibt bis ca. 60% frei.
    d.chord(
        [
            (cx - head_rx * 1.05, head_cy - head_ry * 1.02),
            (cx + head_rx * 1.05, head_cy - head_ry * 0.55),
        ],
        start=180,
        end=360,
        fill=ACCENT_DEEP,
    )

    # 7) Schriftzug "Claudia" unten mittig
    label = "Claudia"
    font_size = int(size * 0.13)
    font = find_font(font_size)
    bbox = d.textbbox((0, 0), label, font=font)
    tw = bbox[2] - bbox[0]
    ty = int(size * 0.85)
    d.text(((size - tw) / 2 - bbox[0], ty - bbox[1]), label, fill=INK, font=font)

    # Abschliessend leicht glaetten
    img = img.filter(ImageFilter.SMOOTH)

    return img


def main():
    for size in (192, 512):
        out = PWA / f"icon-{size}.png"
        img = draw_icon(size)
        img.save(out, format="PNG", optimize=True)
        print(f"wrote {out} ({size}x{size})")


if __name__ == "__main__":
    main()
