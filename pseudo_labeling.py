"""Batched Ultralytics object detection on disjoint image shards."""

import math
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class LabelTarget:
    folder_id: str
    relative_path: str
    image: Path
    label: Path


def cuda_device_count() -> int:
    import torch

    return torch.cuda.device_count() if torch.cuda.is_available() else 0


def predict_images(
    model_path: str, targets: list[LabelTarget], gpu_ids: list[int], batch_size: int,
    save: Callable[[LabelTarget, list[dict]], None],
    *, image_size: int | None = None, confidence: float = 0.25,
) -> None:
    from ultralytics import YOLO
    import torch

    devices = [torch.device("cuda", index) for index in gpu_ids] or [torch.device("cpu")]
    size_option = {"imgsz": image_size} if image_size is not None else {}
    stop = threading.Event()

    def run_device(device: torch.device, shard: list[LabelTarget]) -> None:
        model = YOLO(model_path)
        if model.task != "detect":
            raise ValueError(f"객체 탐지(detect) 모델을 선택하세요. 현재 모델 유형: {model.task}")
        names = model.names
        for offset in range(0, len(shard), batch_size):
            if stop.is_set():
                return
            batch = shard[offset:offset + batch_size]
            results = model.predict(
                source=[str(target.image) for target in batch], device=device, batch=len(batch),
                classes=None, conf=confidence, verbose=False, save=False, save_txt=False, **size_option,
            )
            if len(results) != len(batch):
                raise RuntimeError("배치 이미지 수와 모델 결과 수가 일치하지 않습니다.")
            for target, result in zip(batch, results):
                boxes = result.boxes.cpu()
                annotations = []
                for cls, coords in zip(boxes.cls.tolist(), boxes.xywhn.tolist()):
                    x, y, width, height = coords
                    if not all(math.isfinite(v) and 0 <= v <= 1 for v in coords):
                        continue
                    if width > 0 and height > 0:
                        annotations.append(dict(label_id=int(cls), model_label_name=names[int(cls)],
                                                x=x, y=y, width=width, height=height))
                save(target, annotations)

    # Each thread owns its detector and runs every batch on the same explicit device.
    with ThreadPoolExecutor(max_workers=len(devices)) as pool:
        futures = [
            pool.submit(run_device, device, targets[index::len(devices)])
            for index, device in enumerate(devices) if index < len(targets)
        ]
        try:
            for future in as_completed(futures):
                future.result()
        finally:
            stop.set()
