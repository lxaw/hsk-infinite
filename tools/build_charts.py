"""Draw the charts for chart-description writing (HSK 3.0 levels 7-9, 图表描述) with matplotlib.

Each unit of a `chart_essay` part has a `chart`:
    {"type": "bar" | "barh" | "pie" | "line", "title": "...", "labels": [...], "values": [...],
     "unit": "%", "series": {"2019": [...], "2023": [...]}  # line/bar with several series instead of values
    }
and is drawn to site/images/<level>/<id>.jpg (skipped when it exists, unless --force).

    .venv/bin/python tools/build_charts.py --level hsk79n [--force]
"""
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

ROOT = Path(__file__).resolve().parent.parent
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"]  # validated categorical order
INK, MUTED, GRID = "#1f1d1a", "#6d675f", "#e2dcd2"


def draw(c, dest):
    font_manager.fontManager.addfont(FONT)
    plt.rcParams.update({"font.family": font_manager.FontProperties(fname=FONT).get_name(), "font.size": 13,
                         "text.color": INK, "axes.labelcolor": INK, "xtick.color": MUTED, "ytick.color": MUTED})
    fig, ax = plt.subplots(figsize=(8, 5), dpi=110)
    unit = c.get("unit", "")
    labels = c["labels"]
    if c["type"] == "pie":
        ax.pie(c["values"], labels=[f"{l}\n{v}{unit}" for l, v in zip(labels, c["values"])], colors=SERIES[:len(labels)],
               startangle=90, counterclock=False, wedgeprops={"linewidth": 2, "edgecolor": "white"}, textprops={"fontsize": 12})
        ax.axis("equal")
    else:
        series = c.get("series") or {"": c["values"]}
        for spine in ("top", "right"):
            ax.spines[spine].set_visible(False)
        ax.spines["left"].set_color(GRID)
        ax.spines["bottom"].set_color(GRID)
        if c["type"] == "line":
            for i, (name, vals) in enumerate(series.items()):
                ax.plot(labels, vals, color=SERIES[i], linewidth=2, marker="o", markersize=6, label=name or None)
                ax.annotate(f"{vals[-1]}{unit}", (len(labels) - 1, vals[-1]), textcoords="offset points", xytext=(8, 0), va="center", fontsize=11)
            ax.grid(axis="y", color=GRID)
        else:
            n = len(series)
            width = 0.8 / n
            for i, (name, vals) in enumerate(series.items()):
                pos = [x + (i - (n - 1) / 2) * width for x in range(len(labels))]
                bars = (ax.barh if c["type"] == "barh" else ax.bar)(pos, vals, width * 0.92, color=SERIES[i], label=name or None)
                for b, v in zip(bars, vals):
                    if c["type"] == "barh":
                        ax.text(b.get_width(), b.get_y() + b.get_height() / 2, f" {v}{unit}", va="center", fontsize=11)
                    else:
                        ax.text(b.get_x() + b.get_width() / 2, b.get_height(), f"{v}{unit}", ha="center", va="bottom", fontsize=11)
            if c["type"] == "barh":
                ax.set_yticks(range(len(labels)), labels)
                ax.invert_yaxis()
                ax.grid(axis="x", color=GRID)
            else:
                ax.set_xticks(range(len(labels)), labels)
                ax.grid(axis="y", color=GRID)
            ax.set_axisbelow(True)
        if len(series) > 1:
            ax.legend(frameon=False)
        if c.get("ylabel"):
            ax.set_ylabel(c["ylabel"])
    ax.set_title(c["title"], fontsize=15, pad=30 if c["type"] == "pie" else 14, color=INK)
    fig.tight_layout()
    fig.savefig(dest, format="jpg", facecolor="white", pil_kwargs={"quality": 90})
    plt.close(fig)


def main():
    args = sys.argv[1:]
    level = args[args.index("--level") + 1]
    cfg = json.loads((ROOT / "levels" / f"{level}.json").read_text())
    out = ROOT / "site/images" / level
    out.mkdir(parents=True, exist_ok=True)
    n = 0
    for s in cfg["sections"]:
        for p in s["parts"]:
            f = ROOT / "bank" / level / f"{p['id']}.json"
            if p.get("kind") != "chart_essay" or not f.exists():
                continue
            for u in json.loads(f.read_text()):
                dest = out / f"{u['id']}.jpg"
                if dest.exists() and "--force" not in args:
                    continue
                draw(u["chart"], dest)
                n += 1
    print(f"{level}: {n} charts drawn")


if __name__ == "__main__":
    main()
