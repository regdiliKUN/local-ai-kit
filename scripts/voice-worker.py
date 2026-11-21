#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
voice-worker.py —— 控制台「语音输入」的本地转写进程（faster-whisper）。

常驻运行，模型只加载一次。协议是一行一个 JSON：
  stdin  ← {"id": 1, "path": "C:\\...\\clip.webm", "lang": "zh"}
  stdout → {"id": 1, "text": "……", "ms": 812}
           {"id": 1, "error": "……"}
启动完成时先打一行 {"ready": true, "device": "cuda", "model": "small"}。

全程离线：HF_HUB_OFFLINE=1，模型从 HF_HOME 缓存里读，不会去连网。
"""
import json
import os
import sys
import time

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    sys.stdin.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def load_model(name, device_pref):
    from faster_whisper import WhisperModel
    attempts = []
    if device_pref in ('auto', 'cuda'):
        attempts.append(('cuda', 'float16'))
    if device_pref in ('auto', 'cpu'):
        attempts.append(('cpu', 'int8'))
    last = None
    for device, compute in attempts:
        try:
            model = WhisperModel(name, device=device, compute_type=compute)
            # CUDA 缺 cuDNN / cuBLAS 时构造不报错、第一次推理才炸 —— 先空跑一下验证
            if device == 'cuda':
                import numpy as np
                list(model.transcribe(np.zeros(16000, dtype=np.float32), language='zh')[0])
            return model, device
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f'加载语音模型失败：{last}')


def main():
    name = os.environ.get('LOCALAI_VOICE_MODEL', 'small')
    device_pref = os.environ.get('LOCALAI_VOICE_DEVICE', 'auto')
    try:
        model, device = load_model(name, device_pref)
    except Exception as e:  # noqa: BLE001
        emit({'ready': False, 'error': str(e)})
        return 1
    emit({'ready': True, 'device': device, 'model': name})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get('id')
        t0 = time.time()
        try:
            lang = req.get('lang') or 'zh'
            kwargs = {'language': lang, 'vad_filter': True, 'beam_size': 5}
            if lang == 'zh':
                # Whisper 中文默认常出繁体，给一句简体提示把它拉回来
                kwargs['initial_prompt'] = '以下是普通话的句子，使用简体中文。'
            segments, _info = model.transcribe(req['path'], **kwargs)
            text = ''.join(s.text for s in segments).strip()
            emit({'id': rid, 'text': text, 'ms': int((time.time() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001
            emit({'id': rid, 'error': str(e)})
    return 0


if __name__ == '__main__':
    sys.exit(main())
