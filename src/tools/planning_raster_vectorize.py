#!/usr/bin/env python3
"""Conservative raster-plan line/polygon recovery for the Phase 30D extractor."""

from __future__ import annotations

import argparse
import html
import json
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
    parser.add_argument("--max-shapes", type=int, default=50000)
    args = parser.parse_args()

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
    shapes: list[str] = []

    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=lambda contour: cv2.arcLength(contour, True), reverse=True)
    for contour in contours:
        if len(shapes) >= args.max_shapes:
            break
        perimeter = cv2.arcLength(contour, True)
        area = abs(cv2.contourArea(contour))
        if perimeter < minimum_length or area < minimum_area or area > maximum_area:
            continue
        approximation = cv2.approxPolyDP(contour, max(1.0, perimeter * 0.0015), True)
        if len(approximation) < 3 or len(approximation) > 512:
            continue
        colour = sampled_colour(image, approximation)
        shapes.append(
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
            if len(shapes) >= args.max_shapes:
                break
            points = np.asarray([[[x1, y1]], [[x2, y2]]], dtype=np.int32)
            colour = sampled_colour(image, points)
            shapes.append(
                f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
                f'stroke="{colour}" fill="none" stroke-width="1" '
                f'data-raster-method="hough" />'
            )

    output = Path(args.output)
    output.write_text(
        "\n".join([
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
            *shapes,
            "</svg>",
        ]),
        encoding="utf-8",
    )
    if args.red_ocr_output:
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        red = cv2.bitwise_or(
            cv2.inRange(hsv, np.asarray([0, 45, 35]), np.asarray([18, 255, 255])),
            cv2.inRange(hsv, np.asarray([165, 45, 35]), np.asarray([179, 255, 255])),
        )
        red = cv2.morphologyEx(red, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
        red = cv2.resize(red, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        red_ocr = cv2.bitwise_not(red)
        cv2.imwrite(args.red_ocr_output, red_ocr)
    print(json.dumps({"width": width, "height": height, "shapes": len(shapes), "method": "opencv-canny-contours-hough"}))


if __name__ == "__main__":
    main()
