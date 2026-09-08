#!/usr/bin/env python3
"""Local MLX adapter. stdout: one JSON result; library progress goes to stderr."""
import argparse
import contextlib
import json
import sys
import wave

parser = argparse.ArgumentParser()
parser.add_argument("audio", nargs="?")
parser.add_argument("--model", default="small")
parser.add_argument("--language", default="ru")
parser.add_argument("--warmup", action="store_true")
args = parser.parse_args()
try:
    with contextlib.redirect_stdout(sys.stderr):
        import mlx_whisper
        model = args.model if "/" in args.model else "mlx-community/whisper-" + args.model + "-mlx"
        if args.warmup:
            import numpy as np
            result = mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=model, language=args.language, fp16=True, verbose=False)
            print(json.dumps({"ready": True, "model": model}), file=sys.__stdout__)
            sys.exit(0)
        if not args.audio:
            parser.error("audio is required")
        result = mlx_whisper.transcribe(args.audio, path_or_hf_repo=model, language=args.language, fp16=True, verbose=False)
    with wave.open(args.audio) as wav:
        duration = int(wav.getnframes() / wav.getframerate() * 1000)
    print(json.dumps({"text": result["text"].strip(), "language": result.get("language", args.language), "durationMs": duration}, ensure_ascii=False))
except Exception as error:
    print("Whisper: " + str(error), file=sys.stderr)
    sys.exit(1)
