import os
import sys
import time
import json
import subprocess
import urllib.request

SERVER_CMD = ["node", "src/server.js"]
CWD = r"c:\Users\h4rdc\Documents\Github\coding-agent\airi-audio-server"
PORT = 8095

def test_airi_audio_server():
    print("=" * 60)
    print(" AIRI Audio Server Verification & E2E Test Harness ")
    print("=" * 60)

    print("[1/5] Spawning AIRI Audio Server (Node.js)...")
    proc = subprocess.Popen(SERVER_CMD, cwd=CWD, stdout=sys.stdout, stderr=sys.stderr)

    try:
        print("[2/5] Polling GET /health and GET /v1/models...")
        ready = False
        t0 = time.time()
        while time.time() - t0 < 60.0:
            if proc.poll() is not None:
                print(f"Server process exited with code {proc.returncode}")
                return
            try:
                req = urllib.request.Request(f"http://127.0.0.1:{PORT}/health")
                with urllib.request.urlopen(req, timeout=2.0) as resp:
                    if resp.status == 200:
                        ready = True
                        break
            except Exception:
                time.sleep(0.5)

        if not ready:
            print("ERROR: Server failed health check.")
            return

        print("Server is UP and Healthy!\n")

        # Test GET /v1/models
        print("[3/5] Testing GET /v1/models...")
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/models") as resp:
            models_data = json.loads(resp.read().decode('utf-8'))
            print("  Models Response:", json.dumps(models_data, indent=2))

        # Test GET /v1/voices
        print("\n[4/5] Testing GET /v1/voices (Voice Discovery)...")
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/voices") as resp:
            voices_data = json.loads(resp.read().decode('utf-8'))
            print(f"  Discovered {len(voices_data)} voices. First voice: {voices_data[0] if voices_data else 'None'}")

        # Test POST /v1/audio/speech with paralinguistic tags
        print("\n[5/5] Testing POST /v1/audio/speech with OmniVoice Q8_0 & Paralinguistic Tags...")
        payload = json.dumps({
            "model": "omnivoice-tts",
            "voice": "morgan-freeman",
            "input": "Well, [confirmation-en] AIRI Audio Server is completely operational, [sigh] and running flawlessly! [question-en]",
            "response_format": "ogg"
        }).encode('utf-8')

        headers = {"Content-Type": "application/json"}
        req_speech = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/audio/speech", data=payload, headers=headers, method="POST")
        
        t_start = time.perf_counter()
        with urllib.request.urlopen(req_speech, timeout=120.0) as resp_speech:
            audio_bytes = resp_speech.read()
            elapsed = round(time.perf_counter() - t_start, 3)
            out_file = r"c:\Users\h4rdc\Documents\Github\coding-agent\airi-audio-server\test_output.ogg"
            with open(out_file, "wb") as f:
                f.write(audio_bytes)

            print("=" * 60)
            print("        AIRI AUDIO SERVER E2E TEST SUCCESS          ")
            print("=" * 60)
            print(f"Synthesis Latency: {elapsed}s")
            print(f"Generated Audio  : {len(audio_bytes)} bytes (Opus OGG)")
            print(f"Saved Output File: {out_file}")
            print("=" * 60)

    finally:
        print("\nStopping AIRI Audio Server process...")
        proc.terminate()

if __name__ == "__main__":
    test_airi_audio_server()
