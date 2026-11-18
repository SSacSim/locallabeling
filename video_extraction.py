"""Stream sampled video frames into project-ready YOLO folders."""

import subprocess
import tempfile
from collections.abc import Callable, Iterator
from contextlib import closing
from pathlib import Path

VIDEO_EXTENSIONS = {
    ".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".wmv",
    ".mpg", ".mpeg", ".ts", ".mts", ".m2ts", ".flv",
}
STAGING_PREFIX = ".labeling-extract-"


def sampled_jpegs(video: Path, fps: float) -> Iterator[bytes]:
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
    except ImportError as exc:
        raise RuntimeError("서버 환경에 imageio-ffmpeg를 설치하세요.") from exc

    # Keep the first available source frame in each sampling interval, including on VFR input.
    bucket = f"floor(t*{fps}+1e-9)"
    previous = f"floor(prev_selected_t*{fps}+1e-9)"
    filters = f"setpts=PTS-STARTPTS,select='isnan(prev_selected_t)+gt({bucket},{previous})'"
    command = [
        get_ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror",
        "-i", str(video), "-map", "0:V:0", "-vf", filters, "-fps_mode", "passthrough",
        "-c:v", "mjpeg", "-q:v", "2", "-f", "mpjpeg", "pipe:1",
    ]
    with tempfile.TemporaryFile() as errors, subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=errors,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    ) as process:
        try:
            # FFmpeg's multipart JPEG muxer prefixes each complete JPEG with its byte length.
            for header in process.stdout:
                if header.lower().startswith(b"content-length:"):
                    size = int(header.split(b":", 1)[1])
                    if size <= 0 or process.stdout.readline().strip():
                        raise ValueError("JPEG 프레임 헤더를 읽을 수 없습니다.")
                    jpeg = process.stdout.read(size)
                    if len(jpeg) != size:
                        raise ValueError("JPEG 프레임이 완전하지 않습니다.")
                    yield jpeg
            if process.wait():
                errors.seek(0)
                reason = errors.read(500).decode("utf-8", errors="replace").strip()
                raise ValueError(f"영상을 해독할 수 없습니다. {reason}")
        finally:
            if process.poll() is None:
                process.kill()


def extract_videos(
    videos: list[Path], destination: Path, fps: float, max_images: int,
    progress: Callable[[str, int, int], None], classes_text: str,
) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    total_images = total_folders = 0
    with tempfile.TemporaryDirectory(prefix=STAGING_PREFIX, dir=destination.parent) as temp:
        dataset = Path(temp) / destination.name
        dataset.mkdir()
        for index, video in enumerate(videos, 1):
            progress(video.name, total_images, total_folders)
            written = 0
            try:
                with closing(sampled_jpegs(video, fps)) as frames:
                    for jpeg in frames:
                        if written % max_images == 0:
                            part = written // max_images + 1
                            folder = dataset / f"{index:03d}_{video.stem[:80]}_{part:04d}"
                            (folder / "images").mkdir(parents=True)
                            (folder / "labels").mkdir()
                            (folder / "classes.txt").write_text(classes_text, encoding="utf-8", newline="\n")
                            total_folders += 1
                        written += 1
                        (folder / "images" / f"{written:08d}.jpg").write_bytes(jpeg)
                        total_images += 1
                        progress(video.name, total_images, total_folders)
                if not written:
                    raise ValueError("추출할 영상 프레임이 없습니다.")
            except (OSError, ValueError, RuntimeError) as exc:
                raise ValueError(f"{video.name} — {exc}") from exc
        dataset.rename(destination)
    return destination
