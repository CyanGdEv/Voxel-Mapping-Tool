#!/usr/bin/env python3
"""Conservative raster-plan line/polygon recovery for the Phase 30D extractor."""

from __future__ import annotations

import argparse
import html
import json
import os
from pathlib import Path

import cv2
import numpy as np


def points_text(points: np.ndarray) -> str:
    return " ".join(f"{int(point[0])},{int(point[1])}" for point in points.reshape(-1, 2))


def sampled_colour(image: np.ndarray, points: np.ndarray) -> str:
    flattened = points.reshape(-1, 2)
    values = []
    height, width = image.shape[:2]
    for x, y in flattened[:: max(1, len(flattened) // 20)]:
        if 0 <= x < width and 0 <= y < height:
            values.append(image[int(y), int(x)])
    if not values:
        return "rgb(64,64,64)"
    blue, green, red = np.median(np.asarray(values), axis=0).astype(int)
    return f"rgb({red},{green},{blue})"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--red-ocr-output")
    parser.add_argument("--max-polygons", type=int, default=12000)
    parser.add_argument("--max-lines", type=int, default=12000)
    # Kept for compatibility with older callers. When supplied it only tightens
    # each downstream-aligned budget; it no longer lets polygons starve lines.
    parser.add_argument("--max-shapes", type=int)
    args = parser.parse_args()

    opencv_threads = max(1, int(os.environ.get("TPMAP_OPENCV_THREADS", "1")))
    cv2.setNumThreads(opencv_threads)

    max_polygons = max(1, args.max_polygons)
    max_lines = max(1, args.max_lines)
    if args.max_shapes is not None:
        legacy_cap = max(1, args.max_shapes)
        max_polygons = min(max_polygons, legacy_cap)
        max_lines = min(max_lines, legacy_cap)

    image = cv2.imread(args.input, cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"Unable to read raster plan: {args.input}")
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blurred, 55, 145, apertureSize=3, L2gradient=True)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))

    minimum_length = max(10.0, min(width, height) * 0.002)
    minimum_area = max(16.0, width * height * 0.000001)
    maximum_area = width * height * 0.88
    polygon_shapes: list[str] = []
    line_shapes: list[str] = []

    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=lambda contour: cv2.arcLength(contour, True), reverse=True)
    for contour in contours:
        if len(polygon_shapes) >= max_polygons:
            break
        perimeter = cv2.arcLength(contour, True)
        area = abs(cv2.contourArea(contour))
        if perimeter < minimum_length or area < minimum_area or area > maximum_area:
            continue
        approximation = cv2.approxPolyDP(contour, max(1.0, perimeter * 0.0015), True)
        if len(approximation) < 3 or len(approximation) > 512:
            continue
        colour = sampled_colour(image, approximation)
        polygon_shapes.append(
            f'<polygon points="{html.escape(points_text(approximation))}" '
            f'stroke="{colour}" fill="none" stroke-width="1" '
            f'data-raster-method="contour" />'
        )

    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=max(18, int(min(width, height) * 0.01)),
        minLineLength=max(12, int(min(width, height) * 0.008)),
        maxLineGap=max(3, int(min(width, height) * 0.002)),
    )
    if lines is not None:
        ordered = sorted(lines[:, 0].tolist(), key=lambda line: (line[1], line[0], line[3], line[2]))
        for x1, y1, x2, y2 in ordered:
            if len(line_shapes) >= max_lines:
                break
            points = np.asarray([[[x1, y1]], [[x2, y2]]], dtype=np.int32)
            colour = sampled_colour(image, points)
            line_shapes.append(
                f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
                f'stroke="{colour}" fill="none" stroke-width="1" '
                f'data-raster-method="hough" />'
            )

    output = Path(args.output)
    output.write_text(
        "\n".join([
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
            *polygon_shapes,
            *line_shapes,
            "</svg>",
        ]),
        encoding="utf-8",
    )

    red_ocr = {"present": False, "x": 0, "y": 0, "width": 0, "height": 0, "scale": 2}
    if args.red_ocr_output:
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        red = cv2.bitwise_or(
            cv2.inRange(hsv, np.asarray([0, 45, 35]), np.asarray([18, 255, 255])),
            cv2.inRange(hsv, np.asarray([165, 45, 35]), np.asarray([179, 255, 255])),
        )
        red = cv2.morphologyEx(red, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
        nonzero = cv2.findNonZero(red)
        if nonzero is not None:
            x, y, crop_width, crop_height = cv2.boundingRect(nonzero)
            padding = max(16, int(min(width, height) * 0.003))
            x0 = max(0, x - padding)
            y0 = max(0, y - padding)
            x1 = min(width, x + crop_width + padding)
            y1 = min(height, y + crop_height + padding)
            crop = red[y0:y1, x0:x1]
            crop = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
            cv2.imwrite(args.red_ocr_output, cv2.bitwise_not(crop))
            red_ocr = {
                "present": True,
                "x": x0,
                "y": y0,
                "width": x1 - x0,
                "height": y1 - y0,
                "scale": 2,
            }

    print(json.dumps({
        "width": width,
        "height": height,
        "polygons": len(polygon_shapes),
        "lines": len(line_shapes),
        "shapes": len(polygon_shapes) + len(line_shapes),
        "method": "opencv-canny-contours-hough",
        "redOcr": red_ocr,
        "opencvThreads": opencv_threads,
    }))


if __name__ == "__main__":
    main()
