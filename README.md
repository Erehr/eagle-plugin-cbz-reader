<img width="128" height="128" alt="CBZ Reader" src="https://github.com/user-attachments/assets/d519fbd2-5805-4be6-a7ae-651a6423ef91" />

# Eagle CBZ/CBR Reader

Read CBZ and CBR comic archives directly inside Eagle, and pack new CBZ files from images in your library.

## Overview

This plugin adds a comic viewer to Eagle so you can read archived comics without extracting them or switching to another app. It supports CBZ (ZIP) and CBR (RAR), generates a thumbnail from the first page, and includes a separate CBZ Packer window for creating archives from images you have selected.

## Features

- Read CBZ and CBR archives natively inside Eagle
- JPEG, PNG, GIF, WebP, BMP and AVIF pages, including animated WebP, GIF and AVIF
- Single page, double page spread, and continuous vertical scrolling layouts
- Hardware-accelerated scaling and downsampling for large, high-resolution pages
- Right-click drag-to-zoom and left-click panning
- Automatic center-alignment for high aspect-ratio pages
- Page position saved and restored per archive
- Thumbnails generated from the first page
- CBZ Packer for building archives from selected images

## Supported content

Pages inside an archive can be JPEG, PNG, GIF, WebP, BMP or AVIF.

Animated pages work too: animated WebP, GIF and AVIF play in place, at full frame rate, and are shown at their original quality rather than being downscaled.

## Requirements

Eagle 4.0 or later.

## Acknowledgments

The viewer layout, navigation logic, and interface design were heavily inspired by [OpenComic](https://github.com/ollm/OpenComic).
