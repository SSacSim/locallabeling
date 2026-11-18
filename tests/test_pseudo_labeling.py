import threading
import unittest
from collections import Counter, defaultdict
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import torch

from pseudo_labeling import LabelTarget, predict_images
import server


class PseudoLabelingTests(unittest.TestCase):
    def test_devices_get_independent_models_and_disjoint_bounded_batches(self):
        # Exercise multi-device scheduling on a CPU-only test machine.
        barrier = threading.Barrier(2)
        batches = defaultdict(list)
        models = {}
        saved = []

        class Detector:
            task = "detect"
            names = {3: "PERSON", 5: "bus"}

            def predict(self, source, device, batch, **kwargs):
                if device.index not in models:
                    models[device.index] = self
                    barrier.wait(timeout=10)
                batches[device.index].append(len(source))
                if batch != len(source) or kwargs.get("classes") is not None:
                    raise AssertionError("Incorrect batch or model class filter")
                boxes = SimpleNamespace(cls=torch.tensor([3, 5]), xywhn=torch.tensor([[.5, .5, .2, .2]] * 2))
                return [SimpleNamespace(boxes=SimpleNamespace(cpu=lambda: boxes)) for _ in source]

        targets = [LabelTarget("folder", str(i), Path(f"{i}.jpg"), Path(f"{i}.txt")) for i in range(9)]
        with patch("ultralytics.YOLO", side_effect=lambda path: Detector()):
            predict_images("detect.pt", targets, [1, 3], 2,
                           lambda target, boxes: saved.extend((target, b["label_id"], b["model_label_name"]) for b in boxes))
        self.assertIsNot(models[1], models[3])
        self.assertEqual(dict(batches), {1: [2, 2, 1], 3: [2, 2]})
        self.assertEqual(Counter(saved), Counter((t, i, name) for t in targets for i, name in Detector.names.items()))

    def test_incompatible_model_fails_before_saving(self):
        target = LabelTarget("folder", "a.jpg", Path("a.jpg"), Path("a.txt"))
        with patch("ultralytics.YOLO", return_value=SimpleNamespace(task="segment")):
            with self.assertRaises(ValueError):
                predict_images("model.pt", [target], [], 1, lambda *_: self.fail("A segmentation model saved labels"))

    def test_worker_round_trip_with_colliding_and_unregistered_classes(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = server.new_project("검토", ["cat", "bus"])
            folder = {"id": "f", "name": "f", "images_path": str(root), "labels_path": str(root / "labels")}
            project["folders"].append(folder)
            image = root / "image.jpg"
            image.touch()
            txt = server.yolo_label_path_for(folder, image.name)
            meta = server.sidecar_meta_path_for(folder, image.name)
            image_id = server.image_id(project["id"], "f", image.name)
            user = {"role": "admin", "username": "admin"}
            boxes = [
                dict(label_id=i, model_label_name=name, x=.5, y=.5, width=.1, height=.1)
                for i, name in [(0, "person"), (5, "bus"), (9, "truck")]
            ]
            server.write_yolo_annotations(txt, boxes, meta, {}, overwrite=False)
            self.assertEqual([line.split()[0] for line in txt.read_text().splitlines()], ["0", "5", "9"])
            with patch.object(server, "load_state", return_value={"projects": [project]}):
                annotations = server.annotations_for_image(image_id, user)["annotations"]
                self.assertEqual([b["label_name"] for b in annotations], ["person", "bus", "truck"])
                annotations[0]["x"] = .4
                # A manual box can have the same numeric ID and geometry as a model box.
                manual = dict(annotations[0])
                del manual["model_label_name"]
                annotations.insert(0, manual)
                server.save_annotations(server.AnnotationSavePayload(image_id=image_id, annotations=annotations), user)
                project["labels"][0]["name"] = "kitten"
                restored = server.annotations_for_image(image_id, user)["annotations"]
                self.assertEqual([b["label_name"] for b in restored], ["kitten", "person", "bus", "truck"])
                self.assertEqual([b["label_id"] for b in restored], [0, 0, 5, 9])
                self.assertEqual(restored[1]["x"], .4)
                restored[1].pop("model_label_name")
                server.save_annotations(server.AnnotationSavePayload(image_id=image_id, annotations=restored), user)
                self.assertEqual(server.annotations_for_image(image_id, user)["annotations"][1]["label_name"], "kitten")
