#!/usr/bin/env python3
"""NVIDIA Parakeet adapter. Emits exactly one JSON object on stdout."""
import argparse
import contextlib
import json
import sys
import time
import wave

parser = argparse.ArgumentParser()
parser.add_argument("audio", nargs="?")
parser.add_argument("--model", default="nvidia/parakeet-tdt-0.6b-v3")
parser.add_argument("--warmup", action="store_true")
parser.add_argument("--serve", action="store_true")
args = parser.parse_args()

try:
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import soundfile as sf
        import torch
        from transformers import AutoModelForTDT, AutoProcessor

        device = "mps" if torch.backends.mps.is_available() else "cpu"
        processor = AutoProcessor.from_pretrained(args.model)
        model = AutoModelForTDT.from_pretrained(args.model, dtype=torch.float32)
        model.to(device).eval()

        def transcribe(audio_path=None):
            if audio_path is None:
                audio = np.zeros(16000, dtype=np.float32)
            else:
                audio, rate = sf.read(audio_path, dtype="float32")
                if rate != processor.feature_extractor.sampling_rate:
                    raise ValueError("expected 16 kHz audio")
            inputs = processor(audio, sampling_rate=processor.feature_extractor.sampling_rate)
            inputs = inputs.to(device=device, dtype=torch.float32)
            with torch.inference_mode():
                output = model.generate(**inputs)
            return processor.decode(output.sequences[0], skip_special_tokens=True).strip()

        if args.serve:
            print(json.dumps({"ready": True, "model": args.model, "device": device}), file=sys.__stdout__, flush=True)
            for line in sys.stdin:
                request = json.loads(line)
                try:
                    text = transcribe(request["audio"])
                    with wave.open(request["audio"]) as wav:
                        duration = int(wav.getnframes() / wav.getframerate() * 1000)
                    print(json.dumps({"id": request["id"], "text": text, "language": "ru", "durationMs": duration}, ensure_ascii=False), file=sys.__stdout__, flush=True)
                except Exception as request_error:
                    print(json.dumps({"id": request.get("id"), "error": str(request_error)}, ensure_ascii=False), file=sys.__stdout__, flush=True)
            sys.exit(0)

        if args.warmup:
            text = transcribe()
        else:
            if not args.audio:
                parser.error("audio is required")
            text = transcribe(args.audio)

    if args.warmup:
        print(json.dumps({"ready": True, "model": args.model, "device": device}))
    else:
        with wave.open(args.audio) as wav:
            duration = int(wav.getnframes() / wav.getframerate() * 1000)
        print(json.dumps({"text": text, "language": "ru", "durationMs": duration}, ensure_ascii=False))
except Exception as error:
    print("NVIDIA Parakeet: " + str(error), file=sys.stderr)
    sys.exit(1)
