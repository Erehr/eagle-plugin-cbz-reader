<img width="128" height="128" alt="CBZ Reader" src="https://github.com/user-attachments/assets/d519fbd2-5805-4be6-a7ae-651a6423ef91" />

# Eagle CBZ/CBR Reader

Read CBZ and CBR comic archives directly inside Eagle, and pack new CBZ files from images in your library.

## Overview

This plugin adds a comic viewer to Eagle so you can read archived comics without extracting them or switching to another app. It supports CBZ (ZIP) and CBR (RAR), generates a thumbnail from the first page, and includes a separate CBZ Packer window for creating archives from images you have selected.

## Supported content

Pages inside an archive can be JPEG, PNG, GIF, WebP, BMP or AVIF.

Animated pages work too: animated WebP, GIF and AVIF play in place, at full frame rate, and are shown at their original quality rather than being downscaled.

Archives may also contain MP4 or WebM files. This is not part of the CBZ/CBR standard, but some collections use it for short motion pages, so the reader treats such a page as an animated image: it plays automatically, loops, stays muted and has no video controls. A thumbnail can be generated from a video first page if Eagle's FFmpeg module is installed; otherwise the first still image in the archive is used instead.

The CBZ Packer builds archives from still images only.

## Reading a CBZ or CBR

1. Add `.cbz` or `.cbr` files to your Eagle library. Eagle generates a thumbnail from the first page of each archive.
2. Double-click an archive to open it. The reader replaces Eagle's normal preview.
3. Turn pages with the arrow keys, the mouse wheel, or the on-screen navigation.
4. Switch between single page, double page and continuous vertical scrolling from the reader's view controls.
5. Left-click and drag to pan; right-click and drag to zoom.
6. Close the reader to go back to your library. Your page position is saved and restored the next time you open that archive.

Right-clicking a page offers **Save Image** (write a copy to disk), **Copy Image** (to the clipboard), **Unpack Image to Eagle** (add that single page to your library as a new item) and **Set as Thumbnail** (use that page as the archive's thumbnail). None of these change the archive itself.

## Creating a CBZ

1. Select the images you want in Eagle, in any order.
2. Open the plugin from Eagle's plugin menu. The CBZ Packer window opens with your selection listed.
3. Reorder pages by dragging rows, and remove a page from the list with the × button. You can also drag image files from your computer onto the window to add them. Changing this list only changes what goes into the new archive.
4. Type a file name. The `.cbz` extension is added for you.
5. Click **Create CBZ**. The archive is created and added to your library, in the folder you currently have selected.

### Move originals to Trash

The CBZ Packer has an optional **Move originals to Trash** checkbox.

- When it is on, the Eagle items you selected are moved to Eagle's Trash after the new CBZ has been created and added to your library. Images you dragged in from outside Eagle are never touched.
- You are asked to confirm before anything is created or moved, and the confirmation tells you how many items are affected.
- Trashed items stay in Eagle's Trash and can be restored from there until you empty it.
- The checkbox is always off when the window opens and is never remembered between runs, so it can only ever apply if you tick it yourself for that archive.

The plugin makes no other changes to your files. Reading an archive never modifies it.

## Features

- Read CBZ and CBR archives natively inside Eagle
- JPEG, PNG, GIF, WebP, BMP and AVIF pages, including animated WebP, GIF and AVIF
- MP4 and WebM pages played as silent looping animations
- Single page, double page spread, and continuous vertical scrolling layouts
- Hardware-accelerated scaling and downsampling for large, high-resolution pages
- Right-click drag-to-zoom and left-click panning
- Automatic center-alignment for high aspect-ratio pages
- Page position saved and restored per archive
- Thumbnails generated from the first page, including video-first archives when Eagle's FFmpeg module is installed
- CBZ Packer for building archives from selected images

## Requirements

Eagle 4.0 or later. The optional FFmpeg module (installable from Eagle's Plugin Center) is only needed if your archives contain video files and you want thumbnails generated from them.

## Acknowledgments

The viewer layout, navigation logic, and interface design were heavily inspired by [OpenComic](https://github.com/ollm/OpenComic).
