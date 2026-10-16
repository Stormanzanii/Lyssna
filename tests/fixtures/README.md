`dj-mono.mp3` is an 80 ms, 880 Hz mono test tone at 44.1 kHz. The native decoder test checks that narration-style MP3 audio reaches both stereo output channels.

Generate it with:

```powershell
ffmpeg -f lavfi -i "sine=frequency=880:duration=0.08" -ar 44100 -ac 1 -c:a libmp3lame -b:a 64k -map_metadata -1 -y tests/fixtures/dj-mono.mp3
```
